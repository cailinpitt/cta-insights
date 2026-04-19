# cta-bot

Bluesky bots that post visualizations generated from CTA train and bus tracker APIs.

- **Bus**: [@ctabusinsights.bsky.social](https://bsky.app/profile/ctabusinsights.bsky.social)
- **Train**: [@ctatraininsights.bsky.social](https://bsky.app/profile/ctatraininsights.bsky.social)

## Features

- **Bus bunching** — detects clusters of buses on the same route/direction, posts an annotated map, then replies with a ~10-minute timelapse of the cluster
- **Bus gaps** — inverse of bunching: flags long stretches with no bus service, comparing observed spacing against the CTA's published GTFS schedule
- **Train bunching** — detects clusters (2+) of L trains running too close together, same map + timelapse reply flow
- **Train gaps** — flags long stretches with no L service on a given line/direction, using the GTFS rail schedule for expected headways
- **Bus speedmap** — color-codes a bus route by actual vehicle speed over an hour
- **Train speedmap** — color-codes an L line by actual train speed over an hour, with separate ribbons per direction
- **L system snapshot** — map of all active trains system-wide, with a zoomed inset of the Loop
- **Ghost buses / trains** — hourly rollup post listing route+direction pairs where observed active vehicle count is materially below what the scheduled headway + trip duration imply
- **Historical callouts** — posts are annotated with frequency and severity context from prior posts (e.g. "3rd Route 66 bunch reported today", "tightest reported on this line in 30 days")

The bus bot tracks a subset of CTA routes — see `src/routes.js` for the list. The train bot covers all 8 L lines.

## Examples

### Bus bunching

> 🚌 Route 151 (Sheridan) — Southbound
> 3 buses within 889 ft near Michigan & Erie

![Bus bunching example — 3 buses on Route 151 within 889 ft near Michigan & Erie](docs/images/bus-bunching.jpg)

### Bus gap

> 🕳️ Route 147 (Outer Lake Shore Express) — Southbound
> 35 min gap near Foster & Marine Drive — currently scheduled every 9 min

![Bus gap example — 35 min gap on Route 147 near Foster & Marine Drive](docs/images/bus-gap.jpg)

### L system snapshot

> 🚆 CTA L right now
> 3:35 PM CT · 63 trains system-wide
>
> Red 14 · Blue 19 · Brown 9 · Green 11 · Orange 3 · Purple 1 · Pink 6 · Yellow 0

![L system snapshot — live positions of all active CTA L trains](docs/images/snapshot.jpg)

## Setup

1. `cp .env.example .env` and fill in CTA API keys, Bluesky credentials, and a Mapbox token.
2. `npm install`
3. Install `ffmpeg` if you want bunching timelapse replies (`brew install ffmpeg` / `apt install ffmpeg`).

## Scripts

| Command | Description |
|---|---|
| `npm run bunching` | Run bus bunching detection and post |
| `npm run bunching:dry` | Dry run (saves image, no post) |
| `npm run gaps` | Run bus gap detection and post |
| `npm run gaps:dry` | Dry run |
| `npm run fetch-gtfs` | Refresh the GTFS headway index (weekly cron recommended) |
| `npm run speedmap` | Run bus speedmap collection and post |
| `npm run speedmap:dry` | Dry run |
| `npm run train-bunching` | Run train bunching detection and post |
| `npm run train-bunching:dry` | Dry run |
| `npm run train-gaps` | Run train gap detection and post |
| `npm run train-gaps:dry` | Dry run |
| `npm run train-speedmap` | Run train speedmap collection and post |
| `npm run train-speedmap:dry` | Dry run |
| `npm run train-snapshot` | Post L system snapshot |
| `npm run train-snapshot:dry` | Dry run |
| `npm run observe-ghosts` | Bus observer for ghost detection — fetches `routes.ghosts` and logs positions (no posting). Run on a ~5-minute cron. |
| `npm run ghosts` | Post the hourly ghost-bus rollup |
| `npm run ghosts:dry` | Dry run |
| `npm run train-ghosts` | Post the hourly ghost-train rollup |
| `npm run train-ghosts:dry` | Dry run |
| `npm test` | Run the test suite |

## State

Local state lives in `state/` (gitignored):

- `posted.json` — cooldown keys + timestamps, blocks re-posting the same route/direction too often
- `history.sqlite` — SQLite history of every detection/run (posted or cooldown-suppressed). Drives the frequency + severity callouts on each post; rolled off after 90 days.

The DB uses WAL mode — if you inspect `history.sqlite` with a CLI while the bot is running, recent rows may still be in `history.sqlite-wal` until checkpoint.

## GTFS

Gap and ghost detection (bus and train) compare observed service against the CTA's published schedule. `npm run fetch-gtfs` downloads the GTFS feed and builds `data/gtfs/index.json`, a compact `(route/line, direction, day_type, hour) → { median headway, median trip duration }` lookup covering tracked bus routes and all 8 L lines. Run it weekly — headways don't change often, but scheduled service pickups/cuts do. Requires `unzip` on PATH.

## Ghost detection

Ghosts = buses/trains missing from the road versus what the schedule implies. The model is `trip_duration / headway` = expected active vehicles per direction, compared against the median distinct-vehicle count per polling snapshot over the past hour. A ghost event requires the gap to be ≥25% of expected **and** ≥3 vehicles in absolute terms.

Observations are written to the `observations` table in `history.sqlite` from inside `getVehicles` and `getAllTrainPositions`, so every API call made by any job contributes. To guarantee consistent bus coverage for routes not touched by bunching/gaps, a dedicated observer cron (`npm run observe-ghosts`) fetches `routes.ghosts` on a fixed ~5-minute cadence. Trains need no dedicated observer — the train API returns all 8 lines in one call, which bunching/gaps jobs already make regularly.

Recommended crontab additions:

```
# Ghost bus observer — feeds the hourly rollup with consistent coverage
*/5 * * * * cd /path/to/cta-bot && /usr/bin/node scripts/observeGhosts.js >> cron/observe-ghosts-cron.log 2>&1

# Hourly ghost rollups (offset from other jobs to avoid stomping)
7 * * * * cd /path/to/cta-bot && /usr/bin/node bin/ghosts.js >> cron/ghosts-cron.log 2>&1
8 * * * * cd /path/to/cta-bot && /usr/bin/node bin/trainGhosts.js >> cron/train-ghosts-cron.log 2>&1
```
