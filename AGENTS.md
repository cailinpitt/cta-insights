# AGENTS.md

Operating notes for AI agents editing this repo. Companion to `README.md`
(operator-facing) and `docs/` (per-feature deep-dives).

## What this is

Two Bluesky bots (`@ctabusinsights`, `@ctatraininsights`) + shared alerts
account (`@ctaalertinsights`) that turn live CTA Bus/Train Tracker data into
transit-quality posts. **Cron-driven, no daemon.** Each
`bin/<mode>/<feature>.js` is a one-shot: detect → render → post → exit.

- **Detectors** are pure functions in `src/{bus,train}/<feature>.js`; **bins**
  in `bin/{bus,train}/<feature>.js` wire them to API/DB/post/render.
- **Three Bluesky accounts**: `loginBus` / `loginTrain` / `loginAlerts` —
  don't cross the streams. Pulse + CTA-republished alerts both go to alerts.
- Persistent state in `state/history.sqlite` (WAL, 90-day rolloff). Schema +
  migrations: `src/shared/history.js#db()`.
- Train side: `getAllTrainPositions()` covers all 8 lines in one call, so any
  train job can write to `observations`. No dedicated observer.
- **Metra** (Chicago commuter rail) is being added as a third mode under
  `src/metra/` + `scripts/observeMetra.js` + `scripts/fetch-metra-gtfs.js`.
  Unlike CTA, Metra is timetabled and GTFS-realtime binds each scheduled
  `trip_id` to live predictions — so its detectors (cancellation, delay) read
  schedule adherence directly instead of reconstructing it statistically.
  **Phase 0 (ingestion + schedule index + geometry) is built**; detection +
  posting + frontend are phased in `plan-6-9-26.md` (repo root). See
  `docs/METRA.md`.

**Read first**: `README.md`, `cron/crontab.txt` (what runs when, with stagger
comments), `docs/{ALERTS,BUNCHING,GAPS,GHOSTING,SPEEDMAP,METRA}.md`.

## Hard rules

- `npm test` must pass with zero failures before any commit.
- Don't auto-commit, push, or pull. Wait to be asked.
- Deploy = commit + push from local + `git pull` on the server. Never scp.
- Don't hardcode usernames/paths in committed configs — parameterize and
  substitute at install time (`scripts/install-logrotate.sh`).
- Husky pre-commit runs `biome check --write` on staged `*.{js,json}`. On
  failure, fix the cause and create a new commit (don't amend).
- Update docs alongside code so they don't go stale.
- When you make a change to bus logic, you should consider making the equivalent change to the train logic (or vice versa). Even though the train and bus logic is seperate, the implementation should be kept in parallel as much as possible.

## Invariants that break things if violated

Brief list; deeper rationale in the linked deep-dives.

- **Compute callouts BEFORE `recordX(...)`** — else the new event is compared
  against itself.
- **Always call `recordX({..., posted: false})` on cooldown skips** — recap
  and analytics need the row.
- **Bus reads MUST use `getVehiclesCachedOrFresh`** outside `observeBuses.js`
  and speedmap. Direct `getVehicles` blows the quota.
- **Don't lower observe-buses below `*` (every minute)** without first
  re-checking the 100k/day bus tracker cap. `MIN_SNAPSHOTS` in
  `src/bus/ghosts.js` and `maxStaleMs` in `src/bus/api.js` are coupled to
  this cadence — move them together if it changes.
- **Stagger new `*-alerts` / `*-pulse` cron entries**. Same wall minute
  breaks threading (each sees no parent and posts top-level).
- **GTFS index throws past 7 days old**. After laptop sleep / cron outage,
  run `npm run fetch-gtfs` before manual runs.
- **Don't merge the active vs. headway/duration loops in `fetch-gtfs.js`**.
  `activeByHour` is keyed per direction and counts every revenue trip;
  `headways`/`durations` are keyed **per pattern** (origin→dest, after the
  dominant service_id filter). Merging suppresses bus ghost detection on
  multi-terminal routes — see `docs/GHOSTING.md`.
- **Headways are per-pattern, not per-direction.** Each `routes[r][dir]` carries
  a `patterns[]` list (one entry per origin→dest terminal pair, with endpoint
  coords + `tripCount`); `headways`/`durations`/`terminalLat`… at the direction
  level are the *dominant* pattern's, kept as a fallback. Consumers resolve a
  live pid to a group via `matchPattern` in `src/shared/gtfs.js` (endpoint
  match). This is why mixing short-turns/branches into one bucket is wrong — it
  read the 66 at ~6 min vs a true 30 overnight. Don't revert to a per-direction
  median.
- **Pids are stringified everywhere** (`parseVehicle`) so cache and
  fresh-API rows compare strict-equal.
- **Recovered (`approx`) train positions are visualization-only.** A train the
  feed returns at 0,0 is recovered from its `nextStaNm` (`recoverUnpositionedTrain`)
  and written to `observations` tagged `approx=1`, so the replay/videos stay
  continuous. Detection reads (`getTrainObservations`, `getRecentTrainPositions`,
  `getLineCorridorBbox`) **filter `approx` by default** — pass `includeApprox` to
  opt in. `getAllTrainPositions` likewise returns only real positions unless
  called with `{ includeApprox: true }` (the live video captures do). Don't drop
  the filter without re-validating ghost/gap/pulse counts.
- **`recordAlertSeen` is called twice per new alert** (pre-post `postUri:null`,
  post-post with URI). The pre-post write is what `audit-alerts` uses to
  detect crashed posts — don't refactor to one call.
- **Pulse `active_post_uri` pinning** is what makes the eventual ✅ clear
  target the right thread. Don't replace with time-window lookups.
- **Pulse `from_station`/`to_station` are pinned once posted** — see
  `bin/train/pulse.js#handleCandidate` and `docs/ALERTS.md`.
- **Train pulse "winding down" leaves `pulse_state` intact** — don't advance
  clear ticks when GTFS expects < 1 trip/hour, or you'll post bogus "running
  again" replies at end of service nightly.
- **Loop lines (Brown/Orange/Pink/Purple/Yellow)** ship one round-trip GTFS
  direction. Train ghosts aggregate line-wide; pulse splits via
  `LOOP_LINE_TRDR_OUTBOUND`; the disruption-map renderer uses
  `truncateRoundTrip` (disruption-aware) — see `docs/ALERTS.md` for the
  return-leg apex case.
- **`hourlyLookup` after 4 AM uses today's bucket only** (no prior-day
  weekday fallback). Before 4 AM, prior-day is preferred (CTA encodes
  1:15 AM Sunday as "25:15:00" under Saturday's service_id). Background:
  `docs/GHOSTING.md`.
- **Cold-start grace** for both pulses: zero observations in past 6h ⇒
  service-not-yet-started, not blackout. Train: `getLineCorridorBbox` null
  suppresses the synthetic full-line candidate. Bus:
  `getActiveBusRoutesSince(now-6h)` filters `detectBusBlackouts`.
- **Service-corridor clip** — `detectDeadSegments` excludes bins outside
  the past-6h obs bbox; synthesized candidates clip from/to to in-corridor
  stations. Stops weekend Purple Express track from reading cold.
- **Metra cancellations: feed-health guard + hourly rollup ≠ threaded
  incident.** The inferred-cancellation layer (`src/metra/cancellations.js`) is
  suppressed when `isFeedHealthy` fails — a fleet-wide feed stall makes every
  trip look unobserved. Cancellations are recorded to `disruption_events`
  (`posted=0`, website-data-first) and posted only as an hourly per-line rollup
  (`bin/metra/cancellations.js`), with NO per-incident thread/clear machinery —
  don't add one. Dedup is keyed on `trip_id` + `serviceDate`
  (`getMetraCancelledTripIds`); the same `trip_id` repeats every weekday, so
  dropping the date scope would suppress today's cancellation because last
  week's was recorded.

### Held-train + multi-signal correlation (post-2026-05-03)

Pulse can't see "held trains still pinging from a stopped state." Two
complements:

- **Held-cluster detection** (`src/train/heldClusters.js`) flags ≥ 2
  stationary trains within 1 mi when no moving train is nearby in the same
  direction. Flows through `handleCandidate` as `kind: 'held'`.
- **Multi-signal roundup** (`bin/incident-roundup.js`) — sub-threshold
  signals on the same line within 30 min get a single text-only ack. See
  `docs/ALERTS.md` for scoring.

### CTA alerts significance gate

`src/shared/ctaAlerts.js`. Veto first on `MINOR_PATTERNS` against summary
(headline + shortDescription); admit on `MAJOR_PATTERNS` regex hitting
fullText, OR `alert.major === true` AND `severityScore >= MIN_SEVERITY = 3`.
Bus relevance is "any route in `busRoutes.names`"; train is "any rail line".
Full rules: `docs/ALERTS.md`.

### Threading rules (alerts account)

All posts about one disruption share one thread root. `resolveReplyRef`
(`src/shared/bluesky.js`) inherits `root` from the parent's `reply.root`.
Four cases (pulse-first/CTA-first/pulse-only/CTA-only) detailed in
`docs/ALERTS.md`. `hasUnresolvedCtaAlert` picks bot-clear variant text;
`hasObservedClearForPulse` is the idempotency check.

## Where to look for X

| Editing… | Start here |
|---|---|
| Cron schedule / cadence | `cron/crontab.txt` |
| DB schema, cooldown helpers, callouts | `src/shared/history.js` |
| Observation reads/writes | `src/shared/observations.js` |
| Cooldown acquire / race | `src/shared/state.js`, `src/shared/postDetection.js` |
| GTFS index lookups / build | `src/shared/gtfs.js`, `scripts/fetch-gtfs.js` |
| Bus / Train API | `src/bus/api.js`, `src/train/api.js` |
| Metra API / feed decode | `src/metra/api.js` (GTFS-rt protobuf), `scripts/observeMetra.js` |
| Metra schedule index + line/station geometry | `scripts/fetch-metra-gtfs.js`, `src/metra/data/*` |
| Metra line metadata | `src/metra/lines.js` |
| Metra cancellations (confirmed + inferred) | `src/metra/cancellations.js`, `bin/metra/cancellations.js`, `src/metra/schedule.js` |
| Metra alerts / speedmap | `src/metra/{metraAlerts,speedmap}.js`, `bin/metra/{alerts,speedmap}.js` |
| Bunching / Gap / Ghost detection | `src/{bus,train}/{bunching,gaps,ghosts}.js` |
| Pulse | `src/{bus,train}/pulse.js` + `bin/{bus,train}/pulse.js` |
| Speedmap | `src/{bus,train}/speedmap.js` |
| CTA alert fetch + significance gate | `src/shared/ctaAlerts.js` |
| Alert post text + truncation | `src/shared/alertPost.js` |
| Disruption (pulse/manual) text | `src/shared/disruption.js` |
| Threading + post helpers | `src/shared/bluesky.js` |
| Map renderers | `src/map/index.js`, `src/map/common.js` |
| Recap | `src/shared/recap.js`, `src/shared/recapPost.js` |
| Bus route lists | `src/bus/routes.js` |
| Train station/line data | `src/train/data/{trainStations,trainLines}.json` |
| Audit invariants | `bin/audit-alerts.js` |
| Event-replay track archiver | `bin/export-event-tracks.js`, `src/shared/eventTracks.js`, `docs/REPLAY.md` |
| Video dropout/bridge/ghost model | `src/shared/videoTracks.js` (shared by bus + train bunching/gap/snapshot videos + frontend replay), `docs/REPLAY.md` |
| Cron wrapper | `bin/cron-run.sh` |

## Operational levers (coupled or quota-related only)

Greppable; only the load-bearing ones are listed here. Most thresholds are
single-file constants — search the relevant `src/{bus,train}/<feature>.js`.

| Lever | File | Note |
|---|---|---|
| Bus cache window | `src/bus/api.js` | `maxStaleMs = 90s` — coupled to observe-buses cadence |
| Ghost min snapshots | `src/bus/ghosts.js` | `MIN_SNAPSHOTS = 4` — coupled to observe-buses cadence |
| Train pulse bin | `bin/train/pulse.js` | `MIN_HOUR = 5`, `POST_COOLDOWN_MS = 90 min` |
| Train gap cap | `bin/train/gaps.js` | `TRAIN_GAP_DAILY_CAP = 2` per rush period; cap-exempt on recent pulse/ghost |
| Roundup scoring | `bin/incident-roundup.js` | `WINDOW_MS = 30 min`, `SCORE_THRESHOLD = 1.75`, per-source persistence bonus capped at +0.5 |
| Loop trunk override scope | `src/train/speedmap.js` | `LOOP_TRUNK_LINES = {brn, org, pink, p}` |
| History rolloff | `src/shared/history.js` | `ROLLOFF_DAYS = 90` |
| Observation rolloff | `src/shared/observations.js` | `ROLLOFF_MS = 7d` |
| GTFS staleness | `src/shared/gtfs.js` | `STALE_FATAL_MS = 7d` |

## Dev commands

`npm test` (full suite), `npm run smoke` (`--check` import smoke for each
bin), `npm run check`/`lint` (Biome), `npm run <feature>:dry` (run a bin
without posting). Pulse-specific: `PULSE_DRY_RUN=1`. Alerts-specific:
`ALERTS_DRY_RUN=1`. Replay harness: `scripts/replay-pulse.js` re-runs
detection at synthetic `now` against historical observations
(`--line=red --start=ISO --end=ISO`, `--all-lines --days-back=7`, `--step=2m`).

## Required env vars

`.env` at repo root (see `.env.example`):

- `CTA_TRAIN_KEY`, `CTA_BUS_KEY`, `MAPBOX_TOKEN`
- `METRA_API_KEY` — Metra GTFS-realtime token (`api_token` query param)
- `BLUESKY_SERVICE` (optional, default `https://bsky.social`)
- `BLUESKY_{BUS,TRAIN,ALERTS}_{IDENTIFIER,APP_PASSWORD}`
- `BLUESKY_METRA_{IDENTIFIER,APP_PASSWORD}` (analytics: speedmap/recap) and
  `BLUESKY_METRA_ALERTS_{IDENTIFIER,APP_PASSWORD}` (Metra disruptions/alerts)
- `HISTORY_DB_PATH` overrides default `state/history.sqlite` (tests)
