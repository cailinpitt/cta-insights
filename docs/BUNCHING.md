# Bunching detection

How the bot finds clusters of buses or trains running too close together — the classic "you wait 20 minutes, then three show up at once" pattern.

## What "bunching" means

In a healthy schedule, vehicles on the same route are spread out evenly. **Bunching** is when two or more vehicles end up running within a short distance of each other, usually because the lead vehicle got delayed (heavy boarding, traffic, signals) and the one behind caught up. The riders behind the bunch suffer a long gap; the bunch itself runs nearly empty after the first vehicle.

The bot watches for clusters and posts a map showing where they are.

## The plain-English version

Every few minutes, the bot:

1. Pulls the live position of every bus or train on the routes it watches.
2. Sorts vehicles by how far they've traveled along their route.
3. Looks for groups where consecutive vehicles are closer together than a "bunching" distance threshold.
4. If a cluster is large enough and not just sitting at a terminal, posts a map.

A bus post looks like this:

> 🚌 Route 22 (Clark) Northbound — 3 buses bunched within 2,400 ft

The map shows the route line with each clustered vehicle marked along it, plus nearby intersections so a rider can recognize where they are.

## The technical version

### Buses — `src/bus/bunching.js`

Buses report a `pdist` field: feet traveled along the current pattern. That makes "are these two buses close together along the route?" a simple subtraction — no GPS math, no along-track snapping.

For each pattern (`pid`):

1. Filter to fresh observations (less than 3 minutes old).
2. Sort by `pdist`.
3. Sweep adjacent pairs. A consecutive gap of ≤ **800 ft** (~2.5 Chicago blocks) extends the current cluster.
4. Skip clusters that start within **500 ft** of the pattern start — those are layovers at the origin terminal, not bunching.
5. Rank clusters by size (more vehicles = more severe), tie-break on tighter max-gap.

The hourly bin (`bin/bus/bunching.js`) iterates ranked candidates and picks the first whose `pid` and route aren't on cooldown. Both pid- and route-level cooldowns exist because opposite-direction patterns on the same route would otherwise post within minutes of each other on the same underlying delay.

Additional terminal filtering at post time: even if `pdist` looks fine, if the cluster's nearest stop *is* the first or last named stop, it's a terminal layover and gets skipped.

### Trains — `src/train/bunching.js`

Trains don't report along-route distance, only lat/lon. So we have to compute "distance along the line" ourselves:

1. Build a polyline for the line from CTA's GTFS shapes (`src/train/speedmap.js#buildLinePolyline`). Loop lines (Brown/Orange/Pink/Purple) get the return leg trimmed so both directions snap to the same outbound track.
2. For each train, **perpendicular-project** its lat/lon onto that polyline to get a "track distance" — feet from the line's start. Perpendicular projection (not vertex-snap) matters because CTA train polylines are sparse — only ~80 vertices over 20 miles. Vertex-snapping would put trains hundreds of feet off.
3. Group by `(line, trDr)`, sort by track distance, sweep for clusters within **2,000 ft** (~0.38 mi).
4. Dedupe near-coincident snaps (< 200 ft apart) — almost always the same train double-reported.
5. Reject clusters in the terminal zone (a fraction of total line length).
6. **Heading gate**: every consecutive pair in the cluster must point within 60° of each other. Without it, opposite-direction trains on the elevated Loop snap to similar track distances and falsely appear bunched.

The chosen cluster is rendered as a map showing the line with each train marked at its snapped position.

### Cooldowns and posting

A successful post records the pid (or line/trDr) on cooldown so we don't keep firing on the same incident. Pattern-level *and* route-level cooldowns exist for buses; line-level cooldowns for trains. There's also a daily cap (3 bus bunches/day) so a bad day doesn't drown the feed.

## Why this approach

The signal is geometric, not statistical: vehicles on the same pattern, close together, in service territory. Most of the code is filtering — terminal layovers, ghost reports, opposite-direction noise — to make sure the post matches what a rider on the street would actually see.

## Files

- `src/bus/bunching.js` — bus cluster detection.
- `src/bus/bunchingPost.js` / `src/bus/bunchingVideo.js` — post and time-lapse rendering.
- `src/train/bunching.js` — train cluster detection with along-track snapping.
- `src/train/speedmap.js` — polyline building and projection helpers (shared with speedmap).
- `bin/bus/bunching.js`, `bin/train/bunching.js` — cron entry points.
