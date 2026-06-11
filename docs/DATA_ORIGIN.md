# Web data origin (R2)

The high-churn public data files (`alerts.json`, `daily-counts.json`) are served
from **Cloudflare R2** at `https://data.chicagotransitalerts.app`, not committed
into the Pages repo. This removes the every-~7-minutes data commit (and the
deploy it triggered) from `cta-alert-history`.

## Data flow

```
cta-insights (server)                         cta-alert-history (GitHub Pages)
─────────────────────                         ────────────────────────────────
bin/push-web-data.sh                          runtime: client fetch()s
  export-web.js   -> tmp/web-data/alerts.json     https://data.chicago…/alerts.json
  export-daily.js -> tmp/web-data/daily-counts     (VITE_DATA_BASE_URL, always fresh)
  cmp vs .last  ── unchanged? stop
        │ changed
        ├─ rclone copyto … r2web:cta-alert-history-data    build time: scripts/fetch-data.js
        │   (Cache-Control: max-age=30)           pulls the same files from R2 into
        └─ POST repository_dispatch ─────────►    public/data/, then vite + postbuild
            {event_type: data-updated}            prerender OG cards / feed / csv
```

- **Live app data** comes straight from R2 — fresh regardless of when the site
  was last built.
- **Prerendered per-incident OG cards** (for social crawlers) still need a build.
  That's triggered two ways, mirroring the old dual web-push model:
  - **event-driven** — `push-web-data.sh` fires `repository_dispatch` on change,
  - **catch-up** — `deploy.yml`'s `schedule` (every 30 min) for any missed dispatch.

`CHANGELOG.md` and `alerts.csv` stay site-served (low-churn / build artifacts).

## One-time setup

### R2 bucket + custom domain (Cloudflare dashboard)

Requires the `chicagotransitalerts.app` zone on Cloudflare (see the DNS
migration). Then:

1. **R2 → Create bucket** → `cta-alert-history-data` (separate from `cta-insights-db-backups`).
2. **Bucket → Settings → Custom Domains → Connect Domain** → `data.chicagotransitalerts.app`.
   Cloudflare provisions the cert and auto-creates the proxied DNS record.
3. **Bucket → Settings → CORS policy** → add:

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

   **`AllowedOrigins` MUST be `["*"]`, not a specific-origin list.** This data is
   public by design (see the README "Data as an API"), so `*` is correct — but
   the load-bearing reason is caching. When R2 is given specific origins it
   echoes the matching one back and adds **`Vary: Origin`** to the response.
   Cloudflare refuses to edge-cache any response whose `Vary` contains anything
   other than `Accept-Encoding`, so the file becomes uncacheable
   (`cf-cache-status: DYNAMIC`) and **every** poll/visitor is proxied to the R2
   origin. R2 origin TTFB spikes badly under load (observed 4–37s on 2026-06-10),
   so with no edge cache those spikes hit real users. `["*"]` returns
   `Access-Control-Allow-Origin: *` with no `Vary: Origin`, which lets Cloudflare
   cache per the upload's `Cache-Control: max-age=30` — origin is then hit only on
   the ~30s revalidation per edge node, and everyone else gets a fast edge HIT.

   Verify after applying: `curl -sI -H 'Origin: https://chicagotransitalerts.app'
   https://data.chicagotransitalerts.app/alerts.json | grep -i 'cf-cache-status\|vary'`
   — expect no `Vary: Origin`, and `cf-cache-status` flips to `HIT`/`MISS` (not
   `DYNAMIC`) on the second request. If it stays `DYNAMIC`, add a Cloudflare
   **Cache Rule** (Caching → Cache Rules): match hostname
   `data.chicagotransitalerts.app` → *Eligible for cache* → *Respect origin TTL*.

### R2 write credentials (server)

The backups token is scoped to `cta-insights-db-backups` only, so the data
bucket needs its own token + rclone remote (leaving the backup setup untouched).

1. **R2 → Manage R2 API Tokens → Create** → Object Read & Write, scoped to
   **`cta-alert-history-data`** only. Save the Access Key ID, Secret, and the
   account S3 endpoint.
2. On the server, add a dedicated `r2web` remote (paste your own creds — stays
   in `~/.config/rclone/rclone.conf`, never in git):
   ```sh
   rclone config create r2web s3 \
     provider=Cloudflare \
     access_key_id=<ACCESS_KEY_ID> \
     secret_access_key=<SECRET_ACCESS_KEY> \
     endpoint=https://<account-id>.r2.cloudflarestorage.com \
     acl=private
   ```
   Verify: `rclone lsf r2web:cta-alert-history-data` returns cleanly (empty, no
   AccessDenied).

### GitHub dispatch token (server)

`push-web-data.sh` needs a token to fire the rebuild. Create a **fine-grained
PAT** scoped to the `cailinpitt/chicago-transit-alerts` repo with **Contents:
Read and write** (sufficient to POST `repository_dispatch`). Put it in the
server's cta-insights env (the same place other secrets live, e.g. `.env` /
`debugging/config.sh`) as `GITHUB_DISPATCH_TOKEN`, so both cron and the
event-driven spawn inherit it.

## Cutover (flip the switch once the origin is verified)

Do these together, then watch one deploy:

1. **Verify the origin** is live: `curl -I https://data.chicagotransitalerts.app/alerts.json`
   returns 200 (after `push-web-data.sh` has run once and uploaded).
2. **Frontend repo** — stop tracking the data files so they leave git history
   going forward:
   ```sh
   git rm --cached public/data/alerts.json public/data/daily-counts.json
   printf 'public/data/alerts.json\npublic/data/daily-counts.json\n' >> .gitignore
   ```
   (`CHANGELOG.md` / `alerts.csv` stay tracked.)
3. **Deploy** the frontend changes (R2-origin fetch, `prebuild` fetch, new
   `deploy.yml` triggers). The client reads R2 by default — the origin is baked
   into `src/lib/dataSource.js` (`VITE_DATA_BASE_URL` only overrides it, e.g.
   for a staging bucket).
4. **Server** — deploy the new `push-web-data.sh`, set `GITHUB_DISPATCH_TOKEN`,
   and confirm a run logs `uploaded to r2web:cta-alert-history-data` + `repository_dispatch
   … (http 204)`.

## Rollback

The client now reads R2 as its hardcoded default (`src/lib/dataSource.js`); there
is no longer a site-local `data/` fallback. To revert to the old git-commit flow:
point `DATA_ORIGIN` back at the site-local `data/` path (or set
`VITE_DATA_BASE_URL` to it), restore the old `push-web-data.sh` git-commit flow,
and re-commit the data files. The R2 objects are harmless to leave in place.
```
