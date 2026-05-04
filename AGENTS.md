# AGENTS.md

Operating notes for AI agents editing this repo. Companion to `README.md`
(operator-facing) and `docs/` (per-feature deep-dives).

## What this is

Two Bluesky bots (`@ctabusinsights`, `@ctatraininsights`) plus a shared
alerts account (`@ctaalertinsights`) that turn live CTA Bus/Train Tracker
data into transit-quality posts. **Cron-driven, no daemon.** Each
`bin/<mode>/<feature>.js` is a one-shot script that detects → renders → posts
→ exits.

**Read first**: `README.md` (features + setup), `cron/crontab.txt` (what runs
when, with stagger comments), `docs/{ALERTS,BUNCHING,GAPS,GHOSTING,SPEEDMAP}.md`
(per-feature deep dives).

## Hard rules

- `npm test` must pass with zero failures before any commit.
- Don't auto-commit, push, or pull. Wait to be asked.
- Deploy = commit + push from local + `git pull` on the server. Never scp.
- Don't hardcode usernames/paths in committed configs — parameterize and
  substitute at install time (see `scripts/install-logrotate.sh`).
- Husky pre-commit runs `biome check --write` on staged `*.{js,json}`. If
  it fails, fix the underlying issue and create a new commit (don't amend).
- Documentation should be updated whenever a change is made, so it doesn't get stale.

## Dev commands

| Command | Purpose |
|---|---|
| `npm test` | Full suite via `node --test`. |
| `npm run smoke` | Loads each bin with `--check` (imports only). |
| `npm run check` | Format + safe lint fixes across the repo. |
| `npm run lint` | Biome lint, no writes. |
| `npm run <feature>:dry` | Run a bin without posting; image goes to `assets/`. |
| `node bin/.../X.js --check` | Import smoke for one bin. |
| `PULSE_DRY_RUN=1 node bin/train/pulse.js` | Pulse-specific dry env var. |
| `ALERTS_DRY_RUN=1 node bin/{bus,train}/alerts.js` | Alerts-specific dry. |

## Architecture in 30 seconds

```
                    +-------------------+
                    | scripts/observe-  |   bus tracker
                    | Buses.js (*/10)   |--- API call (chunked 10 routes)
                    +-------------------+
                              |
                              v
               recordBusObservations() -> observations table (SQLite WAL)
                              |
                              v
                getLatestBusSnapshot (maxStaleMs = 11 min)
                              |
        +---------+---------+---------+---------+
        v         v         v         v         v
     bunching   gaps     pulse    speedmap   ghosts
        |         |         |         |         |
        +---------+---------+---------+---------+
                              |
                              v
                Render (sharp + Mapbox Static) → post → recordX
```

- **Detectors** are pure functions in `src/{bus,train}/<feature>.js`.
- **Bins** in `bin/{bus,train}/<feature>.js` wire detectors to API/DB/post/render.
- **Three Bluesky accounts**: `loginBus` / `loginTrain` / `loginAlerts` —
  don't cross the streams. Pulse + CTA-republished alerts both go to
  the alerts account.
- All persistent state lives in `state/history.sqlite` (WAL mode, 90-day
  rolloff). Schema + migrations are in `src/shared/history.js#db()`.
- Train side: `getAllTrainPositions()` returns all 8 lines in a single call,
  so any train job can be the writer to `observations`. No dedicated observer.

## The API budget (silent constraint)

CTA bus tracker is capped at **100k calls/month**. Current shape:

- `observe-buses` `*/10` — sole writer for the all-routes workload (~56k/mo).
- `bus-speedmap` — 60min × 30s polling × 12 runs/day (~43k/mo).
- patterns + predictions ≈ 500/mo.

Bunching, gaps, and pulse all read the cache via `getVehiclesCachedOrFresh`
(`maxStaleMs = 11 min`) and contribute zero direct API calls. This is
load-bearing — see invariants below.

## Invariants that break things if violated

- **Compute callouts BEFORE `recordX(...)`** — else the new event is
  compared against itself.
- **Always call `recordX({..., posted: false})` on cooldown skips** — recap
  and analytics need the row even when no post fired.
- **Bus reads MUST use `getVehiclesCachedOrFresh`** outside of
  `scripts/observeBuses.js` and speedmap. Direct `getVehicles` calls blow
  the 100k/month quota.
- **Don't lower observe-buses cadence below `*/10`** without dropping
  speedmap or accepting the quota hit.
- **`MIN_SNAPSHOTS` in `src/bus/ghosts.js` is coupled to observer cadence**
  (4 = ~6 polls/hour with 2 drops tolerated). Move both together.
- **Stagger new `*-alerts` / `*-pulse` cron entries** against existing ones.
  If they fire on the same wall minute, threading breaks (each sees no
  parent and posts top-level).
- **GTFS index throws past 7 days old** (calendar_dates makes it
  date-specific). After laptop sleep / cron outage, run `npm run fetch-gtfs`
  before manual runs.
- **`activeByHour` counts every revenue trip; `headways` / `durations` are
  filtered by dominant service_id + dominant origin.** Don't merge the loops
  in `scripts/fetch-gtfs.js` — applying the dominance filters to active
  counts chronically underestimates multi-terminal routes and suppresses
  bus ghost detection.
- **Pids are stringified everywhere** (`parseVehicle`) so cache and
  fresh-API rows compare strict-equal.
- **`alert_posts` rows are never hard-deleted by the alerts pipeline** —
  only by `rolloffOld` once `resolved_ts` is older than 90 days.
- **`recordAlertSeen` is called twice per new alert** (pre-post with
  `postUri:null`, post-post with the URI). Don't refactor to one call —
  the pre-post write is what `audit-alerts` uses to detect crashed posts.
- **Pulse `active_post_uri` pinning** is what makes the eventual ✅ clear
  target the right thread. Don't replace with time-window lookups.
- **Detection bins are wrapped in `runBin(main)`** — relies on `--check`
  short-circuit for the smoke test.
- **Train pulse "winding down" leaves `pulse_state` intact** — don't
  advance clear ticks when GTFS expects < 1 trip/hour, or you'll post a
  bogus "running again" reply at end of service every night.
- **Loop lines (Brown/Orange/Pink/Purple/Yellow)** ship a single GTFS
  direction_id covering the round trip. Train ghosts aggregate line-wide
  for these; pulse splits via `LOOP_LINE_TRDR_OUTBOUND`. The **disruption
  map renderer** also has to handle round-trip polylines specially: the
  raw `trainLines.json` shape goes terminus→Loop→terminus as one
  polyline, so naively splitting at from/to leaves the return-leg half
  redrawing bright over the dim segment on short stretches. `splitSegments`
  calls `truncateRoundTrip(seg, fromLoc, toLoc)` first to prune at the
  apex, mirroring `processSegment` in `speedmap.js` — but the truncation
  is disruption-aware: if either endpoint is closer to the dropped
  (return-leg) half than the kept half, the disruption sits on the apex
  itself (Loop-section pulses) and the full polyline is returned to
  avoid chopping the very geometry the suspended segment lives on.
- **`hourlyLookup` after 4 AM uses today's bucket only**, no fallback
  to prior-day weekday. The previous fallback caused M-F-only bus
  routes (31, 143, …) to look "scheduled" on Saturday morning because
  the lookup leaked Friday's counts; same root cause produced false
  Yellow/Purple synthetic train pulses at 5 AM Saturday. Before 4 AM,
  prior-day is still preferred because CTA encodes 1:15 AM Sunday as
  "25:15:00" under Saturday's service_id (the late-night extended-day
  case is real).
- **Pulse `from_station` / `to_station` are pinned once posted** —
  `bin/train/pulse.js#handleCandidate` only writes from/to to
  `pulse_state` while `active_post_uri` is null. After posting, the
  row keeps the original station names so the eventual `✅` clear
  reply matches the original suspended-post text. Without this the
  cold run could drift one station per tick during a long outage and
  the clear would name different endpoints.
- **Cold-start grace** for both pulses: a line/route with zero
  observations in the past 6 hours is treated as service-not-yet-
  started rather than blackout. Train side: `getLineCorridorBbox`
  returning null suppresses the synthetic full-line candidate. Bus
  side: `getActiveBusRoutesSince(now-6h)` is passed to
  `detectBusBlackouts`; routes not in the set are skipped.
- **Service-corridor clip** — `detectDeadSegments` accepts an
  `opts.corridorBbox` (past-6h obs bbox for the line) and excludes
  bins outside it from the cold-run scan and coverage denominator.
  This is what stops weekend Purple Express track (Howard → Loop) from
  reading as cold every weekend morning. Synthesized full-line
  candidates also clip from/to to in-corridor stations.

## Held-train + multi-signal correlation (post-2026-05-03)

Train pulse measures absence of pings; it can't see "held trains still pinging from a stopped state." Two complements:

- **Held-cluster detection** (`src/train/heldClusters.js`) flags ≥ 2 stationary trains clustered within 1 mi when no moving train is nearby in the same direction. Per-train motion comes from `src/train/motion.js` (stationary = displacement ≤ 500 ft over ≥ 3 obs spanning ≥ 5 min). Held candidates flow through the same `handleCandidate` machinery as cold candidates with `kind: 'held'` and a different post template (`🚇🚨 service halted around X` instead of cold "trains not seen").
- **Multi-signal roundup** (`bin/incident-roundup.js`) — when individual detectors all hit sub-threshold signals on the same line within 30 min, the roundup posts a single text-only acknowledgment. Each detector writes to a new `meta_signals` table on near-misses; roundup scores by max-severity-per-source then sums sources, with score ≥ 2.0 triggering a post (60-min cooldown per line).

Key supporting changes shipped together: trailing-tail threshold drop on ghost (admits `missing ≥ 2` when deficit concentrates in window tail), gap-cap reset per rush period (AM 05–10, midday 10–15, PM 15–20, evening 20–05) with cap-exempt on recent pulse/ghost correlation, terminal-adjacency veto (1.2× margin) and dispatch-continuity veto (1.5× margin) on cold-segment detection, `inLoopTrunk` override scoped to round-trip lines only.

## Replay harness

`scripts/replay-pulse.js` re-runs detection against historical observations at synthetic `now` values. Used to validate detector changes against past incidents without burning shadow weeks. Examples: `--line=red --start=ISO --end=ISO`, `--all-lines --days-back=7`, `--step=2m`.

## Threading rules (alerts account)

All posts about one disruption must share one thread root, regardless of
which producer fires first. Implementation: `resolveReplyRef`
(`src/shared/bluesky.js`) inherits `root` from the parent's `reply.root`
when present, so reply-of-reply lands in the same thread.

The four cases:
- **Pulse first, CTA second**: pulse pins `active_post_uri`. CTA bin runs
  `getRecentPulsePostsAll(line, withinMs=24h)`, scores by station-name
  overlap, threads under the winner.
- **CTA first, pulse second**: pulse runs `findOpenAlertReplyRef` (top-5
  most recent unresolved CTA alerts on the line, station-overlap scored)
  and threads under the winner.
- **Pulse only**: bot ✅ clear replies under `active_post_uri`. Variant
  text "(CTA hasn't issued an alert for this.)"
- **CTA only**: CTA top-level + threaded `✅ CTA has cleared:` reply.

`hasUnresolvedCtaAlert({kind, ctaRouteCode})` decides bot-clear variant
text; `hasObservedClearForPulse({pulseUri})` is the idempotency check
for clear replies (so a process kill between post + state-finalize
doesn't double-post the clear).

## CTA alerts significance gate (`src/shared/ctaAlerts.js`)

Single most important filter; reject "Major" alerts that are trivial
(elevator, stop relocation) while admitting genuine disruptions even
with `MajorAlert=0`.

1. summary = headline + shortDescription; fullText adds fullDescription.
2. **Veto** on `MINOR_PATTERNS` against summary only (long-form text
   legitimately mentions "elevator"/"entrance" even on real outages).
3. **Admit A**: any `MAJOR_PATTERNS` regex hits fullText.
4. **Admit B**: `alert.major === true` AND `severityScore >= MIN_SEVERITY = 3`.

Bus relevance gate is "any route in `busRoutes.names`" (~130 routes —
every active CTA bus route, since `isSignificantAlert` already gates
noise). Train is "any rail line" (all 8). One match keeps the whole
alert with all its routes intact.

## Where to look for X

| Editing… | Start here |
|---|---|
| Cron schedule / cadence | `cron/crontab.txt` |
| DB schema, cooldown helpers, callouts | `src/shared/history.js` |
| Observation reads/writes | `src/shared/observations.js` |
| Cooldown acquire / race | `src/shared/state.js`, `src/shared/postDetection.js` |
| GTFS index lookups | `src/shared/gtfs.js` |
| GTFS index build | `scripts/fetch-gtfs.js` |
| Bus API + cache window | `src/bus/api.js` |
| Train API + line metadata | `src/train/api.js` |
| Bunching detection | `src/{bus,train}/bunching.js` |
| Gap detection | `src/{bus,train}/gaps.js` |
| Ghost detection | `src/{bus,train}/ghosts.js` |
| Pulse (route/segment dark) | `src/{bus,train}/pulse.js` + `bin/{bus,train}/pulse.js` |
| Speedmap collection + sampling | `src/{bus,train}/speedmap.js` |
| CTA alert fetch + significance gate | `src/shared/ctaAlerts.js` |
| Alert post text + truncation | `src/shared/alertPost.js` |
| Disruption (pulse/manual) text | `src/shared/disruption.js` |
| Threading (`resolveReplyRef`) + post helpers | `src/shared/bluesky.js` |
| Map renderers (entry) | `src/map/index.js` |
| Map common (SVG, glyphs, text measure) | `src/map/common.js` |
| Recap aggregation | `src/shared/recap.js`, `src/shared/recapPost.js` |
| Bus route lists (names, gaps, ghosts) | `src/bus/routes.js` |
| Train station/line data | `src/train/data/{trainStations,trainLines}.json` |
| Audit invariants | `bin/audit-alerts.js` |
| Cron wrapper | `bin/cron-run.sh` |

## Operational levers (single-file knobs)

| Lever | File | Constant |
|---|---|---|
| Bus bunching threshold | `src/bus/bunching.js` | `BUNCHING_THRESHOLD_FT = 800` |
| Bus daily bunching cap | `bin/bus/bunching.js` | `BUS_BUNCHING_DAILY_CAP = 3` |
| Train bunching threshold | `src/train/bunching.js` | `TRAIN_BUNCHING_FT = 2000` |
| Gap ratio / floor | `src/{bus,train}/gaps.js` | `RATIO_THRESHOLD = 2.5`, `ABSOLUTE_MIN_MIN` |
| Ghost gates | `src/bus/ghosts.js` | `MISSING_PCT_THRESHOLD = 0.25`, `MISSING_ABS_THRESHOLD = 3`, `MISSING_ABS_THRESHOLD_TRAILING = 2`, `TRAILING_DEFICIT_MIN = 2`, `MIN_SNAPSHOTS = 4`, `RAMP_FILL_RATIO = 0.8` |
| Train pulse detector | `src/train/pulse.js` | `DEFAULT_BIN_FT = 1320`, `DEFAULT_MIN_RUN_FT_LONG = 10560`, `SOLO_EXPECTED_TRAINS = 3`; vetoes: terminal-adjacency (1.2× margin), dispatch-continuity (1.5× margin) |
| Train pulse bin | `bin/train/pulse.js` | `MIN_CONSECUTIVE_TICKS = 2`, `CLEAR_TICKS_TO_RESET = 3`, `POST_COOLDOWN_MS = 90 min`, `MIN_HOUR = 5`; held detection toggle: `HELD_DETECTION` (default on) |
| Held cluster detector | `src/train/heldClusters.js` | `DEFAULT_HELD_CLUSTER_FT = 5280`, `DEFAULT_HELD_MIN_TRAINS = 2`, `DEFAULT_HELD_MIN_DURATION_MS = 10 min` |
| Motion classifier | `src/train/motion.js` | `DEFAULT_STATIONARY_FT = 500`, `DEFAULT_STATIONARY_MIN_OBS = 3`, `DEFAULT_STATIONARY_MIN_SPAN_MS = 5 min` |
| Loop trunk override scope | `src/train/speedmap.js` | `LOOP_TRUNK_LINES = {brn, org, pink, p}` |
| Train gap cap | `bin/train/gaps.js` | `TRAIN_GAP_DAILY_CAP = 2` per rush period (`chicagoStartOfRushPeriod`); cap-exempt on recent pulse (30 min) or recent ghost (90 min) |
| Roundup scoring | `bin/incident-roundup.js` | `WINDOW_MS = 30 min`, `SCORE_THRESHOLD = 2.0`, `ROUNDUP_COOLDOWN_MS = 60 min` |
| Bus pulse detector | `src/bus/pulse.js` | `MIN_EXPECTED_ACTIVE = 2`, `MIN_OTHER_ROUTES_ACTIVE = 5`, `LOOKBACK_FLOOR_MS = 25 min`, `LOOKBACK_CEIL_MS = 60 min`, `COLD_START_GRACE_MS = 6h` |
| Significance gate | `src/shared/ctaAlerts.js` | `MIN_SEVERITY = 3`, `MAJOR_PATTERNS`, `MINOR_PATTERNS` |
| Alert resolution debounce | `src/shared/history.js` | `ALERT_CLEAR_TICKS = 2`, `ALERT_FLICKER_RESET_MS = 30 min` |
| Bus cache window | `src/bus/api.js` | `getVehiclesCachedOrFresh` `maxStaleMs = 11 min` |
| History rolloff | `src/shared/history.js` | `ROLLOFF_DAYS = 90` |
| Observation rolloff | `src/shared/observations.js` | `ROLLOFF_MS = 48h` |
| Cooldown default | `src/shared/state.js` | `COOLDOWN_MS = 1h` |
| GTFS staleness | `src/shared/gtfs.js` | `STALE_WARN_MS = 2d`, `STALE_FATAL_MS = 7d` |
| Post text caps | `src/shared/alertPost.js` | 200 / 240 / 300 |

## Required env vars

`.env` at repo root (see `.env.example`):

- `CTA_TRAIN_KEY`, `CTA_BUS_KEY` — CTA tracker API keys.
- `MAPBOX_TOKEN` — Mapbox Static Images.
- `BLUESKY_SERVICE` (optional, default `https://bsky.social`).
- `BLUESKY_BUS_IDENTIFIER` / `BLUESKY_BUS_APP_PASSWORD`
- `BLUESKY_TRAIN_IDENTIFIER` / `BLUESKY_TRAIN_APP_PASSWORD`
- `BLUESKY_ALERTS_IDENTIFIER` / `BLUESKY_ALERTS_APP_PASSWORD`

`HISTORY_DB_PATH` overrides the default `state/history.sqlite` (used by
tests).
