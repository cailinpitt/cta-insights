# Gap detection

How the bot finds long stretches of route with no vehicles in service — the rider experience of "the schedule says every 10 minutes, but I've been waiting 30."

## What a "gap" means

The CTA publishes scheduled headways: how often vehicles should arrive on each route. A **gap** is when the actual distance between two consecutive vehicles is large enough — relative to that schedule — that riders in between are waiting much longer than promised.

Where bunching is "vehicles too close," gaps are the inverse: vehicles too far apart.

## The plain-English version

Every few minutes, the bot:

1. Pulls live positions of every bus/train.
2. Sorts vehicles by their position along the route.
3. For each pair of consecutive vehicles, estimates how long it would take a vehicle to cover the empty stretch at typical service speed.
4. Compares that estimate to the scheduled headway.
5. If the gap is more than 2.5× scheduled — and at least 15 minutes for buses or 10 for trains — flags it.

A train post looks like this:

> 🚆 Red Line Northbound — ~24-min gap near Wilson (scheduled every ~7 min)

The map highlights the empty stretch and labels the nearest station so riders know where the wait is happening.

## The technical version

### The core comparison

We don't have ride times for empty stretches — no vehicle is there to measure. So we estimate them from a typical service speed:

- Buses: **880 ft/min** (~10 mph, including stops and signals).
- Trains: **2,200 ft/min** (~25 mph cruise + dwell).

For two consecutive vehicles separated by `gapFt` along the route:

```
gapMin = gapFt / TYPICAL_SPEED_FT_PER_MIN
ratio  = gapMin / expectedHeadwayMin
```

The number is intentionally crude. It's only used as a *ratio* against the scheduled headway, not as a literal ETA. A 2.5× ratio is the threshold: a gap that's two and a half times the schedule is worth posting.

### Buses — `src/bus/gaps.js`

For each pattern (`pid`), we already have `pdist` directly from the API, so:

1. Filter to fresh observations (< 3 min).
2. Sort by `pdist`.
3. For each adjacent pair: skip if either bus is inside the start/end terminal zone (a route-length-scaled buffer — buses there are doing layovers, not running headways).
4. Compute `gapMin` and `ratio`. Reject if `gapMin < 15` (absolute floor — protects 30-min-headway routes from spamming on a 31-min drift) or `ratio < 2.5`.
5. Sort surviving gaps by `ratio` desc — biggest deviations first.

### Trains — `src/train/gaps.js`

Same idea, but track distance comes from snapping lat/lon onto a polyline (same projection as bunching and speedmap). After snapping:

1. Group by `(line, trDr)`, sort by track distance.
2. Look up the scheduled headway for that line + destination via the GTFS index.
3. Skip pairs in the terminal zone.
4. Apply the same ratio + floor gates (10-min floor for trains, since rail headways are tighter).
5. For each surviving gap, compute the **midpoint** in track-distance and find the nearest station to label "near X" — pointing at the empty stretch itself, not at either train's next stop.

### Why a ratio, not a literal ETA

Gap times computed this way will be wrong in absolute terms — a real bus on Western at PM peak averages slower than 10 mph. But the schedule headway has the same kind of error baked in (also derived from a smooth model). When you take their ratio, the modeling error cancels: a true 3× deviation looks like 3× regardless of the constant.

This is why the post says "~24 min" with a tilde — it's deliberately approximate.

## Why this approach

The signal we want is "the schedule said one thing, reality is much worse" — and the only ground truth we have is the live spacing of in-service vehicles. By comparing a model-estimated gap to a model-derived headway and gating with a ratio, we catch big deviations without needing a perfect ETA.

The terminal-zone exclusion and the absolute-minute floor are the two filters that keep the false-positive rate low: gaps near terminals look big but mean nothing for riders mid-route, and one bus being 31 minutes apart on a 30-minute schedule isn't a story.

## Files

- `src/bus/gaps.js` — bus gap detection.
- `src/bus/gapPost.js` — post rendering and image building.
- `src/train/gaps.js` — train gap detection with along-track snapping and station labeling.
- `src/train/gapPost.js` — train post rendering.
- `src/shared/geo.js` — terminal zone helpers (`terminalZoneFt`).
- `bin/bus/gaps.js`, `bin/train/gaps.js` — cron entry points.

## Train gap cap

Train gaps cap at 2 posted events per **rush period** per line — AM (05–10), midday (10–15), PM (15–20), evening (20–05) — instead of per Chicago day. Each rush gets its own budget so two morning Red posts don't suppress an actual evening incident.

When the rush-period cap is hit, the post is bypassed if either correlated signal fires:

- A pulse on the same line within the last 30 min.
- A ghost-detector near-miss (recorded to `meta_signals`) within the last 90 min.

Otherwise the suppressed gap still gets a `meta_signals` row at severity proportional to its ratio, so `bin/incident-roundup.js` can incorporate it into the cross-detector roundup score.
