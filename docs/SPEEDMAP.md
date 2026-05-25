# Speedmaps

How the bot builds the daily "this is how fast a route was actually moving" image — the colored map where red means crawling and green means moving well.

## What a speedmap shows

A speedmap is a one-hour snapshot of how fast vehicles were moving on a single route, segment by segment. The route is divided into 40 equal-length pieces, each colored by the average speed observed there during the window.

It's a way to see exactly *where* a route is slow — not just the headline average. A green-with-one-red-block speedmap means the whole route runs fine except for one chokepoint; a route that's red end-to-end has a different problem entirely.

## The plain-English version

For one chosen route per day, for one hour:

1. Every 30 seconds, the bot fetches every active vehicle's position.
2. For each vehicle, it pairs consecutive observations to compute speed (distance ÷ time).
3. Each speed sample is binned into one of 40 equal-length segments along the route.
4. Every segment averages all the speed samples that landed inside it.
5. Each segment gets a color based on its average speed.
6. The whole thing is drawn on a map and posted with the overall average.

Bus colors: red < 5 mph, orange < 10, yellow < 15, green ≥ 15.
Train colors: red < 15, orange < 25, yellow < 35, purple < 45, green ≥ 45 (matching CTA's slow-zone categories).

## The technical version

### Step 1 — collect

`collect()` (bus) and `collectTrains()` (train) poll the live-positions API on a fixed cadence (default 30 seconds) for the configured duration (default 60 minutes). Every observation is stored under `(vid, pid)` for buses or `(rn, trDr)` for trains — sub-keying by pattern/direction means a vehicle that flips direction mid-window doesn't produce a bogus negative-speed sample crossing the boundary.

### Step 2 — compute samples

A speed *sample* is one mph reading between two consecutive observations of the same vehicle on the same pattern.

**Buses** (`computeSamples`):
- `mph = (Δpdist / Δt) × (3600 / 5280)` — `pdist` is along-route feet, so this is a true along-route speed, not crow-flies.
- Drop pairs where Δt > 3 min (vehicle vanished and reappeared).
- Drop pairs where Δpdist < 0 (pattern restart — vehicle finished a loop).
- Drop pairs > 60 mph (above CTA's route speed ceiling = GPS jump or feed glitch).
- Tag each sample with the **midpoint pdist** for binning, and store as a segment `{startFt, endFt, mph}` for length-weighted binning.

**Trains** (`computeTrainSamples`):
- No `pdist` field — instead, perpendicular-project both lat/lons onto the line polyline to get track distances, then `mph = |Δtrack| / Δt`.
- The polyline-building step (`processSegment`) detects loop lines (start ≈ end) and trims the return leg, so both directions of Brown/Orange/Pink/Purple project onto the same outbound polyline. Without this, sample counts get split between two near-identical polylines and most segments end up below the rendering threshold.
- `maxPerpFt = 1000` rejects off-branch projections — e.g. a train on Green's Cottage Grove branch projecting onto the Ashland/63rd polyline.
- Cap at 70 mph (above 55–65 cruise on Red/Blue, but tight enough to reject GPS jumps).
- Stationary-run dedupe collapses adjacent observations within 50 ft of each other, keeping the earliest timestamp for the speed math and the latest as `lastSeenAt` so the "vanished from feed" gate uses the post-stationary motion gap rather than the full layover duration.
- **Terminal end-bins on trains.** CTA's ttpositions feed has a position-update lag for trains near terminals — every terminal-departure pair (e.g. "0 ft → 4000 ft in 30 sec" on Yellow at Howard) computes to ~100 mph because dt reflects our 30-sec poll cadence rather than actual motion time, so the pair trips the maxMph filter and gets dropped. The first and last bin of each train polyline therefore tend to be null, which produced visible grey notches on Yellow (each bin is 10% of the 5-mi route). The fix is in the renderer (`speedForTrainRender` in `src/map/bus/speedmap.js`): when only an end bin is null, paint it with the color of the nearest interior bin that has data. Interior nulls are *not* filled — those are honest no-data signal. The recorded `binSpeeds`, `summary.avg`, and per-bucket percentages are untouched, so the data path stays measurement-accurate.
- **Single-direction lines (Yellow).** The Yellow Line's GTFS shape is two segments that are exact reverses of one corridor, and Train Tracker reports a single `trDr` (always `1` / dest "Skokie") for the whole line — both physical travel directions are indistinguishable in the feed. `SINGLE_DIRECTION_LINES` in `bin/train/speedmap.js` flags these: the duplicate reverse branch is dropped, all samples merge into one ribbon, and the post shows a single line **Average** with the caption "One ribbon — the CTA feed reports a single direction for the …Line" instead of the dual-direction layout. Before this, Yellow rendered two overlapping ribbons both labeled "Unknown direction" (the feed's "Skokie" didn't match the polyline-terminus station name "Dempster-Skokie", so the direction label resolved to null and the two null-keyed entries failed to dedupe).

### Step 3 — pick the target direction/pattern

Each route has multiple patterns or directions. We pick the one with the **most samples** (highest data density). The post is for that direction; the other directions in the route are not rendered separately in the same post.

### Step 4 — bin into 40 segments

Each segment of the route gets the average mph of every sample whose midpoint (or whose segment overlap, in `binSegments`) lands inside it.

`binSegments` is the more sophisticated version: each `{startFt, endFt, mph}` sample contributes to *every* bin it overlaps, weighted by the overlap length. This eliminates interior no-data bins that midpoint-only bucketing produces on sparse polls. (At a 30-sec poll rate over 60 min you get ~120 polls per vehicle — usually plenty — but on routes with fewer active vehicles, the overlap weighting matters.)

### Step 5 — summarize and color

`summarize()` computes the overall average plus the count of bins falling into each color bucket. Color thresholds are set per-mode (`BUS_THRESHOLDS`, `TRAIN_THRESHOLDS`).

The map (`src/map`) draws the polyline with each segment colored, plus a header showing the route, direction, time window, and average speed.

### A note on geometry

Train speedmaps depend heavily on `snapToLine` and `offsetPolyline`:

- **`snapToLine`** uses perpendicular projection, not vertex-snap. CTA's train shape files have ~80 vertices over 20 miles, so vertex-snapping would put samples hundreds of feet from where they should be — enough to scramble the binning.
- **`offsetPolyline`** lets us draw the inbound and outbound polylines as two parallel tracks (offset perpendicular to the line of travel) for visual clarity, even though sampling collapses both onto a single underlying polyline.

## Why this approach

Average speed is a useful headline number, but the *geographic distribution* of slowness is what tells riders something they didn't already know. A route's overall average can stay flat while a specific 3-block stretch has gotten 30% slower — that's the thing the bins make visible.

The 40-bin granularity is a compromise: fine enough to highlight specific intersections and slow zones, coarse enough that each bin gets enough samples to be meaningful in a 1-hour window.

## Files

- `src/bus/speedmap.js` — bus collection, sampling, binning, color thresholds.
- `src/train/speedmap.js` — train equivalents plus polyline building, perpendicular projection, loop-line trimming.
- `src/map/` — image rendering (route polyline + colored segments + station markers).
- `bin/bus/speedmap.js`, `bin/train/speedmap.js` — cron entry points (one route per run; rotation handled by `history.leastRecentlyPostedSpeedmapRoute`).

## Route selection

Bus speedmaps rotate across **every active CTA bus route** (`allRoutes` in `src/bus/routes.js`). Two filters happen before the picker chooses a route:

1. **In-service window check.** A route is only eligible if `expectedBusRouteActiveTrips` (sum of GTFS `activeByHour` across all directions) is ≥ 2 at both the start and end of the planned 60-minute collection window. This drops peak-only routes about to wind down (would burn 120 polls collecting near-empty data) and routes outside their service hours entirely.
2. **Least-recently-posted picker.** Among the eligible routes, `history.leastRecentlyPostedSpeedmapRoute` picks the one whose most recent posted speedmap is oldest. Never-picked routes are treated as "infinitely old" and jump to the front, so coverage fans out evenly before any route gets a second turn. With ~130 routes and the cron at `0 */2`, expect each route to get a fresh speedmap roughly every 11 days.
