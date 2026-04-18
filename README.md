# cta-bot

Bluesky bots that post visualizations generated from CTA train and bus tracker APIs.

- **Bus**: [@ctabusinsights.bsky.social](https://bsky.app/profile/ctabusinsights.bsky.social)
- **Train**: [@ctatraininsights.bsky.social](https://bsky.app/profile/ctatraininsights.bsky.social)

## Features

- **Bus bunching** — detects clusters of buses on the same route/direction, posts an annotated map, then replies with a ~10-minute timelapse of the cluster
- **Bus gaps** — inverse of bunching: flags long stretches with no bus service, comparing observed spacing against the CTA's published GTFS schedule
- **Train bunching** — detects pairs of L trains running too close together, same map + timelapse reply flow
- **Bus speedmap** — color-codes a bus route by actual vehicle speed over an hour
- **Train speedmap** — color-codes an L line by actual train speed over an hour, with separate ribbons per direction
- **L system snapshot** — map of all active trains system-wide, with a zoomed inset of the Loop
- **Historical callouts** — posts are annotated with frequency and severity context from prior posts (e.g. "3rd Route 66 bunch reported today", "tightest reported on this line in 30 days")

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
| `npm run train-speedmap` | Run train speedmap collection and post |
| `npm run train-speedmap:dry` | Dry run |
| `npm run snapshot` | Post L system snapshot |
| `npm run snapshot:dry` | Dry run |

## State

Local state lives in `state/` (gitignored):

- `posted.json` — cooldown keys + timestamps, blocks re-posting the same route/direction too often
- `history.sqlite` — SQLite history of every detection/run (posted or cooldown-suppressed). Drives the frequency + severity callouts on each post; rolled off after 90 days.

The DB uses WAL mode — if you inspect `history.sqlite` with a CLI while the bot is running, recent rows may still be in `history.sqlite-wal` until checkpoint.

## GTFS

Gap detection compares observed bus spacing against the CTA's published schedule. `npm run fetch-gtfs` downloads the GTFS feed and builds `data/gtfs/index.json`, a compact `(route, direction, day_type, hour) → median headway` lookup. Run it weekly — headways don't change often, but scheduled service pickups/cuts do. Requires `unzip` on PATH.
