# cta-bot

Bluesky bot that posts visualizations generated from CTA train and bus tracker APIs.

## Setup

1. `cp .env.example .env` and fill in CTA API keys + Bluesky credentials.
2. `npm install`

## Ideas in flight

- **Bunching**: flag multiple buses on the same route clustered together.
- **Route speedmap**: color-code a route by actual vehicle speed over a window.
- **Coverage trail**: draw every reported position for a route over a day.
