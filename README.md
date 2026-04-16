# cta-bot

Bluesky bots that post visualizations generated from CTA train and bus tracker APIs.

- **Bus**: [@ctabusinsights.bsky.social](https://bsky.app/profile/ctabusinsights.bsky.social)
- **Train**: [@ctatraininsights.bsky.social](https://bsky.app/profile/ctatraininsights.bsky.social)

## Features

- **Bus bunching** — detects clusters of buses on the same route and direction
- **Train bunching** — detects pairs of L trains running too close together
- **Bus speedmap** — color-codes a bus route by actual vehicle speed over an hour
- **Train speedmap** — color-codes an L line by actual train speed over an hour
- **L system snapshot** — map of all active trains system-wide

## Setup

1. `cp .env.example .env` and fill in CTA API keys + Bluesky credentials.
2. `npm install`

## Scripts

| Command | Description |
|---|---|
| `npm run bunching` | Run bus bunching detection and post |
| `npm run bunching:dry` | Dry run (saves image, no post) |
| `npm run speedmap` | Run bus speedmap collection and post |
| `npm run speedmap:dry` | Dry run |
| `npm run train-bunching` | Run train bunching detection and post |
| `npm run train-bunching:dry` | Dry run |
| `npm run train-speedmap` | Run train speedmap collection and post |
| `npm run train-speedmap:dry` | Dry run |
| `npm run snapshot` | Post L system snapshot |
| `npm run snapshot:dry` | Dry run |
