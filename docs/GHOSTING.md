# Ghost detection

How the bot decides that buses or trains are "missing" — running below the schedule the CTA publishes — and posts about it.

## What "ghosting" means

A **ghost** is the difference between the service the CTA promises and what's actually on the street or rails. If the schedule says nine trains should be running toward 95th/Dan Ryan right now and we only see five, there are four ghost trains.

The bot only posts when the gap is large enough and consistent enough that it almost certainly reflects a real service problem — not a momentary blip in the data feed.

## The plain-English version

Once an hour, for each route or train line, the bot asks two questions:

1. **How many vehicles *should* be running right now?** Pulled from the CTA's published GTFS schedule.
2. **How many vehicles are we actually seeing?** Pulled from CTA's live vehicle-position feed, sampled every ten minutes for the past hour.

If "actually seeing" is meaningfully smaller than "should be running" — and stays that way across the whole hour — the bot posts.

The post looks like this:

> 🚌 Route 94 (California) NB · 3 of 7 missing (45%) · every ~29 min instead of ~16

That's saying: California buses going north should be coming every 16 minutes; they're effectively coming every 29 because three of the seven that should be on the road aren't.

## The technical version

### Step 1 — building the expected-service index

Once a week (or whenever CTA publishes a new schedule), `scripts/fetch-gtfs.js` downloads the full GTFS feed and builds a small JSON index at `data/gtfs/index.json`. For every (route, direction, hour-of-day, day-type) bucket it records:

- **Headway** — median minutes between trip starts. Display only.
- **Duration** — median end-to-end run time. Display only.
- **Active trips** — the *mean number of trips simultaneously in progress* during that hour. This is the ground truth we compare against.

The active-trip count is computed as an area under the curve. For each scheduled trip we know its departure and arrival times. For each hour the trip overlaps, we add the fraction of that hour the trip was in progress:

```
active_in_hour_H += (min(arrival, H_end) - max(departure, H_start)) / 3600
```

A 90-minute trip that runs 16:30–18:00 contributes 0.5 to hour 16, 1.0 to hour 17, and 0 to hour 18. Summed across all scheduled trips, this gives the mean number of vehicles that should be simultaneously running, hour by hour. It's the apples-to-apples comparison for snapshot counts of live vehicles.

Unlike the headway and duration buckets, **active-trip counts include every revenue trip** — short-turn variants and non-dominant service overlays are not filtered out. Headway and duration apply two filters (dominant `service_id` per hour, dominant origin terminal per route+direction) so that "every ~X min" tracks rider-facing frequency without garage pullouts and short-turns collapsing the median. But for "how many buses should be on the street right now", a revenue trip counts regardless of which terminal it left from. Earlier the active counter inherited those filters and chronically underestimated multi-terminal routes (e.g. Route 79 EB at 4 PM read as 6 expected when ~17 were observed); splitting the active loop out fixed this.

(An even earlier version used `duration / headway` as a stand-in for active trips. That works at steady state but breaks during ramp-up/ramp-down hours, where headway is computed from a handful of clustered trip-starts and the formula overestimates by 3-5×. Switching to the area-under-curve definition eliminated a class of false-positive "ghost" calls during morning service start.)

### Step 2 — observing live service

Two scripts feed a SQLite observations table:

- `scripts/observeBuses.js` — runs every ten minutes, fetches every active vehicle on every active CTA bus route. Bunching, gaps, and pulse all read this snapshot via the cache layer, so this script is the only API call site for the all-routes workload.
- The bunching/gap detectors also write every vehicle they see into the same table (so we get extra coverage for free).

Each row records `(ts, route, direction, vehicle_id, ...)`. Observations older than 48 hours are rolled off; the live ghost detectors only look back one hour.

### Step 3 — detecting ghosts

`bin/bus/ghosts.js` and `bin/train/ghosts.js` run hourly (`:07` and `:08` past the hour) and call into `src/bus/ghosts.js` / `src/train/ghosts.js`. The core logic:

1. Pull the last hour of observations for each route/direction.
2. Group observations into per-timestamp snapshots and count distinct vehicles in each snapshot.
3. Take the median of those snapshot counts → `observedActive`.
4. Look up `expectedActive` from the index, using the **midpoint of the observation window** for the time of day — not "now". The cron fires at :07, so the hour-long window covers 53 minutes of the previous wall-clock hour and only 7 minutes of the current one. Looking up "now" mis-bucketed schedule transitions and produced spurious ghosts at e.g. AM rush ramp-up boundaries.
5. Compute `missing = expectedActive - observedActive`. If it clears all the gates below, emit an event.

### Step 4 — gates against false positives

False-positive ghost posts are a credibility risk; the gates exist to swallow ambiguous cases rather than over-call. From `src/bus/ghosts.js`:

| Gate | Threshold | Rationale |
|---|---|---|
| `MISSING_PCT_THRESHOLD` | ≥25% | The deficit must be a real share of expected service, not 1 of 8. |
| `MISSING_ABS_THRESHOLD` | ≥3 vehicles | Avoids firing on routes with tiny absolute counts. |
| `MIN_SNAPSHOTS` | ≥4 | At the 10-min observer cadence the hour-long window holds ~6 snapshots; 4 tolerates up to 2 dropped polls. |
| `MIN_OBSERVED` | ≥2 | "Missing 7 of 9" with observed 0 or 1 is either a genuine outage (the gap detector handles those) or a feed bug. |
| `active < 2` floor | skip | Routes with fewer than 2 expected vehicles are too sparse for a meaningful ghost call. |
| `MAX_EXPECTED_ACTIVE` | ≤30 | Sanity ceiling. >30 has historically meant a bad GTFS bucket; we'd rather skip than post nonsense. |
| Stddev gate | `stddev ≤ observedActive` | If per-snapshot counts swing wildly, that's almost always observer/polling instability, not actually-missing vehicles. |
| Ramp-fill gate | tail-25% median ≥ 80% × expected | If the *end* of the window already shows healthy service, the deficit is at the front of the hour (service ramping up), not now. Real outages persist into the tail. |

Train detection (`src/train/ghosts.js`) mirrors this exactly, with two extra wrinkles:

- **Loop lines** (Brown / Orange / Pink / Purple / Yellow) report a single GTFS direction for the full round trip. We aggregate line-wide rather than per-direction so the expected count isn't artificially halved.
- **Short-turns** (e.g. Blue Line UIC-Halsted) are filtered out: a destination is only used if it resolves to a true terminal station. Mid-route destinations don't have a clean terminal-to-terminal headway and can't be looked up reliably.

### Step 5 — posting

If any events survive the gates, they're sorted by `missing` descending and rendered into a single Bluesky post. The headway shown in each line is *effective* — the scheduled headway scaled by the ratio of expected-to-observed — so "every ~29 min instead of ~16" reflects the rider experience under the deficit, not the schedule on paper. When the deficit is so large that the effective-headway estimate explodes (>3× scheduled), we fall back to "scheduled every ~X min" so the post stops claiming a misleadingly precise number.

If no events clear the gates, the bot stays silent. Silence is the correct answer most hours.

## Why this approach

The CTA publishes a schedule. Live vehicle positions are public. The interesting signal isn't either feed alone — it's the gap between them, sustained over a window long enough to rule out polling noise. That's a genuinely simple idea; almost everything in the code above is in service of *not* crying wolf.

## Files

- `scripts/fetch-gtfs.js` — builds the active-trip index from CTA's published GTFS feed.
- `scripts/observeBuses.js` — ten-minute live observation poller covering every active CTA bus route.
- `src/shared/observations.js` — observation storage and roll-off.
- `src/shared/gtfs.js` — index lookup helpers.
- `src/bus/ghosts.js`, `src/train/ghosts.js` — core detection and gates.
- `bin/bus/ghosts.js`, `bin/train/ghosts.js` — hourly entry points (cron).

## Trailing-tail override

Whole-hour `MISSING_ABS_THRESHOLD = 3` is the right floor for steady deficits but over-rejects mid-incident drops with less evidence accumulated. The override admits at `missing ≥ 2` when:

- `tailMedian < observedActive` (deficit concentrated in the last 25% of the window).
- `trailingDeficit ≥ 2`.

Steady whole-window under-counts of 2 still drop. The train ghost cron also writes near-miss `meta_signals` rows (severity ≥ 0.5) for sub-threshold drops, plus full-strength rows for posted events — `bin/incident-roundup.js` reads these for cross-detector correlation.
