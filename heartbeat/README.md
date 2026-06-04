# cta-heartbeat

Dead-man's-switch for the cta-insights cron pipeline. A single SQLite-backed
Durable Object records every cron job's last-seen timestamp and, via its own
alarm, pushes an ntfy alert when a **monitored** job goes silent past its
budget — and again when it recovers. The watcher runs on Cloudflare,
independent of the home server it watches, so "the box died" is the case it
catches.

## How it fits together

- `bin/cron-run.sh` wraps every cron job. After each run it `POST`s
  `/ping/<slug>?status=ok|fail` to this Worker (no-op unless
  `cron/heartbeat.env` exists on the server).
- The Worker forwards every request to one DO instance (`idFromName('monitor')`).
- The DO upserts `last-seen` per slug into its SQLite store and keeps a 60s
  self-rescheduling alarm running. The alarm compares each **monitored** slug
  against its staleness budget and fires `down` / `up` ntfy notifications.
- Every slug is recorded and visible at `GET /status`; only slugs in
  `MONITORED` (in `src/index.js`) raise alerts. Widen coverage by editing that
  map and redeploying — no server change.

Canaries to start: `observe-buses` and `observe-trains` (every-minute jobs that
feed the whole detection pipeline; 5-minute silence budget).

## One-time setup

1. **Pick an ntfy topic.** Choose an unguessable topic name (it's a public
   bearer capability — anyone who knows it can read/post). Install the ntfy app
   and subscribe to `https://ntfy.sh/<your-topic>`.

2. **Deploy + set secrets** (from this directory):
   ```sh
   npm install
   npx wrangler deploy
   npx wrangler secret put NTFY_URL      # e.g. https://ntfy.sh/<your-topic>
   npx wrangler secret put PING_TOKEN    # any long random string
   ```

3. **Configure the server.** On the box, in the cta-insights checkout:
   ```sh
   cp cron/heartbeat.env.example cron/heartbeat.env
   # edit cron/heartbeat.env: set HB_PING_URL to the deployed Worker URL and
   # HB_PING_TOKEN to the same value as the PING_TOKEN secret above.
   ```
   No crontab change is needed — `cron-run.sh` already pings.

4. **Verify.** Tail `GET https://cta-heartbeat.<subdomain>.workers.dev/status`
   after the next minute; `observe-buses` / `observe-trains` should appear with
   a small `ageSec`. To test alerting, pause those cron lines (or stop the box)
   and confirm an ntfy push arrives within ~5–6 minutes, then a recovery push
   when they resume.

## Extending

- **Alert on more jobs:** add `slug: budget` entries to `MONITORED` and
  redeploy. Budget = job period + a little grace.
- **Alert on crashes too:** the ping already sends `status=fail` on non-zero
  exit; v1 only alerts on silence. To also alert on a job that ran but failed,
  branch on `status` in `alarm()`.
