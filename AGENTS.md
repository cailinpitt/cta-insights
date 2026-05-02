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
  calls `truncateRoundTrip` first to prune at the apex, mirroring
  `processSegment` in `speedmap.js`.

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
| Ghost gates | `src/bus/ghosts.js` | `MISSING_PCT_THRESHOLD = 0.25`, `MISSING_ABS_THRESHOLD = 3`, `MIN_SNAPSHOTS = 4`, `RAMP_FILL_RATIO = 0.8` |
| Train pulse detector | `src/train/pulse.js` | `DEFAULT_BIN_FT = 1320`, `DEFAULT_MIN_RUN_FT_LONG = 10560`, `SOLO_EXPECTED_TRAINS = 3` |
| Train pulse bin | `bin/train/pulse.js` | `MIN_CONSECUTIVE_TICKS = 2`, `CLEAR_TICKS_TO_RESET = 3`, `POST_COOLDOWN_MS = 90 min`, `MIN_HOUR = 5` |
| Bus pulse detector | `src/bus/pulse.js` | `MIN_EXPECTED_ACTIVE = 2`, `MIN_OTHER_ROUTES_ACTIVE = 5`, `LOOKBACK_FLOOR_MS = 25 min`, `LOOKBACK_CEIL_MS = 60 min` |
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
