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

> 🕳️ Red Line — to Howard
>
> No train near Wilson for ~24 min — currently scheduled every 7 min
>
> Last seen: #711 · Next up: #718

The map highlights the empty stretch, tags the two trains **L** (last seen, the one that just passed) and **N** (next up, the one riders are waiting on), and labels the stations flanking the gap so riders know where the wait is happening. The post spells the two roles out instead of `(last)`/`(next)` — "the last train" reads as the final train of the night, which is the opposite of what we mean.

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

## Timelapse reply

After the still gap post goes out, the bot captures a ~10-minute timelapse and threads it as a reply — but framed around the rider's real question, *"is my train coming?"*, not the inter-vehicle span a bunching clip reports.

The clip **follows only the trailing ("Next up") vehicle approaching the wait stop** — which is the **gap midpoint**, not the leading-end stop the post names. The leading vehicle is dropped entirely: it already left, and on bad gaps it sits near a terminal, which would force the bbox miles wide and shrink the markers to specks. Anchoring at the midpoint also halves the distance the next vehicle must cover, so it's actually reachable in a 10-minute clip (a full 15+ min gap never is). By framing `[trailing vehicle path → midpoint stop]`, the camera holds still while the next vehicle advances across it, and the motion *is* the story.

**Wording leads with the full gap, not just the ETA.** Because the wait stop is the midpoint, "next vehicle ~N min away" is only the *remaining* half — it silently drops the time the rider already waited since the last vehicle passed. So both the HUD and the reply lead with the total gap:

- A live **HUD readout** top-left: `~24-min gap · next train ~5 min` (the gap is fixed; the ETA ticks down). The wait stop is named by the amber label on the map, so it's omitted here.
- An **amber target ring + amber label** on the midpoint wait stop (same amber as the gap strip) so the eye lands on where the vehicle is heading.
- The trailing vehicle's **N** chip + comet trail, the direction arrow, and the clip clock.

The reply leads with the service hole, then the progress: *"The Red Line hasn't had a train in ~24 min. 4 minutes later, the next one had closed to 0.87 mi from Wilson."* — or, on arrival, *"…the next one reached Wilson."*

**Deep gaps fall back to the still map** (no reply). Two guards enforce this: skip before capturing if the trailing vehicle's distance to the *midpoint* is too far to close in 10 minutes (>5 mi train / >3 mi bus — the readable-frame ceiling), and skip after capturing if it never meaningfully closed (<0.25 mi train / <0.125 mi bus) and didn't arrive. The worst gaps stay newsworthy as a still.

## Files

- `src/bus/gaps.js` — bus gap detection.
- `src/bus/gapPost.js` — bus post + timelapse reply text.
- `src/bus/gapVideo.js` — bus gap timelapse capture + clip assembly.
- `src/train/gaps.js` — train gap detection with along-track snapping and station labeling.
- `src/train/gapPost.js` — train post + timelapse reply text.
- `src/train/gapVideo.js` — train gap timelapse capture + clip assembly.
- `src/map/bus/gaps.js`, `src/map/train/gaps.js` — still gap maps + timelapse framing views.
- `src/shared/geo.js` — terminal zone helpers (`terminalZoneFt`).
- `bin/bus/gaps.js`, `bin/train/gaps.js` — cron entry points (`--video` dry-run flag renders the clip locally).

## Train gap cap

Train gaps cap at 2 posted events per **rush period** per line — AM (05–10), midday (10–15), PM (15–20), evening (20–05) — instead of per Chicago day. Each rush gets its own budget so two morning Red posts don't suppress an actual evening incident.

When the rush-period cap is hit, the post is bypassed if either correlated signal fires:

- A pulse on the same line within the last 30 min.
- A ghost-detector near-miss (recorded to `meta_signals`) within the last 90 min.

Otherwise the suppressed gap still gets a `meta_signals` row at severity proportional to its ratio, so `bin/incident-roundup.js` can incorporate it into the cross-detector roundup score.
