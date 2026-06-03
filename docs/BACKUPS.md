# Database backups

The history DB (`state/history.sqlite`, ~900 MB and growing) is the one piece
of irreplaceable state on the server — it can't be rebuilt from the code or the
CTA feeds. It lives on a single LVM volume with no RAID, so it's backed up
off-box to **Cloudflare R2** daily.

- `scripts/backup-db.sh` — snapshot → integrity-check → gzip → upload to R2.
- `scripts/restore-db.sh` — pull a snapshot back down and verify it.

The snapshot is taken with SQLite's online `.backup`, which is WAL-safe and
does not block the bots mid-write. A raw `cp` of the `.sqlite` file is **not**
safe — it can capture a torn state while the `-wal` file holds uncommitted
writes.

## One-time setup (on the server)

### 1. Install rclone

```sh
sudo apt update && sudo apt install -y rclone
```

### 2. Create the R2 bucket + API token (Cloudflare dashboard)

1. **R2 → Create bucket** → name it `cta-insights-db-backups`.
2. **R2 → Manage R2 API Tokens → Create API Token**:
   - Permission: **Object Read & Write**
   - Scope it to the `cta-insights-db-backups` bucket.
   - Save the **Access Key ID**, **Secret Access Key**, and the
     **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).

### 3. Configure the `r2` rclone remote

Run this on the server and paste your own credentials — the secret is stored in
`~/.config/rclone/rclone.conf` (mode 600), never in this repo:

```sh
rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=<ACCESS_KEY_ID> \
  secret_access_key=<SECRET_ACCESS_KEY> \
  endpoint=https://<account-id>.r2.cloudflarestorage.com \
  acl=private
```

Verify:

```sh
rclone lsd r2:                       # should list cta-insights-db-backups
scripts/backup-db.sh                 # first real backup
scripts/restore-db.sh --list         # should show the file you just uploaded
```

### 4. Retention (R2 lifecycle rule)

The backup script keeps only 2 local copies; remote retention is handled by an
R2 lifecycle rule rather than scripted deletes (safer — the server can't
accidentally wipe history). In the dashboard: **R2 → cta-insights-db-backups →
Settings → Object lifecycle rules → Add rule → delete objects N days after
creation** (30 days is a reasonable default at this size/cost).

## Schedule

A daily 04:17 entry is in `cron/crontab.txt` under `--- Backups ---`. It runs
off-peak and well clear of the `fetch-gtfs` (03:15) and `fetch-signals`
(04:00 monthly) jobs. Install it with the merge procedure documented at the
top of `cron/crontab.txt`.

Logs: `cron/backup-db-cron.log`.

## Restoring

```sh
scripts/restore-db.sh --list                 # see what's available
scripts/restore-db.sh                         # fetch + verify the latest
scripts/restore-db.sh history-YYYYMMDD-HHMMSS.sqlite.gz   # a specific one
```

The restore script never overwrites the live DB on its own — it verifies the
snapshot into `tmp/db-backups/` and prints the manual swap-in steps (stop
writers → copy into place → re-enable cron). Test a restore periodically; an
unverified backup is only a guess.
