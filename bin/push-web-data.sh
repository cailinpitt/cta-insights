#!/bin/sh
# Publish updated alert data to the R2 data origin and trigger a site rebuild.
#
# Replaces the old git-commit-to-Pages flow. The high-churn data files now live
# in R2 (served at https://data.chicagotransitalerts.app), so data refreshes no
# longer create commits or run a deploy. A rebuild is only needed to refresh the
# prerendered per-incident OG cards / CSV / feed — fired here as a GitHub
# repository_dispatch when the data actually changed, with the Actions schedule
# as the catch-up net.
#
# Invoked both by cron (catch-up) and event-driven (src/shared/webPushTrigger.js
# spawns it ~30s after a new Bluesky post). No-ops when the freshly exported data
# is byte-identical to the last successful upload, so neither the upload nor the
# rebuild fires on unchanged ticks.
#
# Env:
#   CTA_INSIGHTS          repo path (default: parent of this script's dir)
#   RCLONE_REMOTE         rclone remote:bucket (default: r2web:cta-alert-history-data)
#   DISPATCH_REPO         owner/repo to rebuild (default: cailinpitt/chicago-transit-alerts)
#   GITHUB_DISPATCH_TOKEN PAT allowed to POST repository_dispatch on DISPATCH_REPO.
#                         If unset, the upload still happens and a warning is
#                         logged — the scheduled rebuild will catch up.
set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CTA_INSIGHTS="${CTA_INSIGHTS:-$(cd "$SCRIPT_DIR/.." && pwd)}"
REMOTE="${RCLONE_REMOTE:-r2web:cta-alert-history-data}"
DISPATCH_REPO="${DISPATCH_REPO:-cailinpitt/chicago-transit-alerts}"

# Pull GITHUB_DISPATCH_TOKEN from .env when it isn't already in the environment.
# The event-driven path inherits it via the bots' dotenv load, but the */15 cron
# line runs under plain /bin/sh (no dotenv), so without this the cron rebuild
# dispatch would never fire. Keep the token unquoted in .env.
if [ -z "${GITHUB_DISPATCH_TOKEN:-}" ] && [ -f "$CTA_INSIGHTS/.env" ]; then
  GITHUB_DISPATCH_TOKEN=$(grep -E '^GITHUB_DISPATCH_TOKEN=' "$CTA_INSIGHTS/.env" | head -1 | cut -d= -f2-)
fi

WORK="$CTA_INSIGHTS/tmp/web-data"
LAST="$WORK/.last"
mkdir -p "$WORK" "$LAST"

# healthchecks.io ping (optional; mirrors bin/cron-run.sh). Fired from an EXIT
# trap so it covers every exit — the no-op "no change" exit, the normal end, and
# any set -e failure — meaning a quiet (unchanged) tick still counts as alive
# rather than looking silent. The exit code is sent straight to healthchecks
# (0 = success, non-zero = failure). No-op unless cron/healthchecks.env exists.
[ -f "$CTA_INSIGHTS/cron/healthchecks.env" ] && . "$CTA_INSIGHTS/cron/healthchecks.env"
hc_ping() {
  [ -n "${HC_PING_KEY:-}" ] || return 0
  # ?create=1 auto-creates the check on its first ping (no-op once it exists).
  curl -fsS -m 10 --retry 2 -X POST \
    "${HC_PING_URL:-https://hc-ping.com}/$HC_PING_KEY/push-web-data/$1?create=1" >/dev/null 2>&1 || true
}
trap 'hc_ping $?' EXIT

# 1. Export current data into the working dir (readonly DB read, cron-safe).
node "$CTA_INSIGHTS/bin/export-web.js" "$WORK/alerts.json"
node "$CTA_INSIGHTS/bin/export-daily.js" "$WORK/daily-counts.json"

# 2. Change detection: bail if both files match the last successful upload.
changed=0
for f in alerts.json daily-counts.json; do
  if ! cmp -s "$WORK/$f" "$LAST/$f" 2>/dev/null; then
    changed=1
  fi
done
if [ "$changed" -eq 0 ]; then
  echo "push-web-data: no change, skipping upload + rebuild"
  exit 0
fi

# 3. Upload to R2 with a short edge-cache TTL. The client also revalidates on
#    generated_at, so 30s bounds worst-case staleness without hammering origin.
for f in alerts.json daily-counts.json; do
  rclone copyto "$WORK/$f" "$REMOTE/$f" \
    --s3-no-check-bucket \
    --header-upload "Cache-Control: public, max-age=30"
done

# Record the new baseline only after a successful upload.
cp "$WORK/alerts.json" "$LAST/alerts.json"
cp "$WORK/daily-counts.json" "$LAST/daily-counts.json"
echo "push-web-data: uploaded to $REMOTE"

# 4. Trigger a rebuild so prerendered OG cards pick up new incidents.
if [ -n "$GITHUB_DISPATCH_TOKEN" ]; then
  code=$(curl -fsS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$DISPATCH_REPO/dispatches" \
    -d '{"event_type":"data-updated"}') || code="curl-failed"
  echo "push-web-data: repository_dispatch -> $DISPATCH_REPO (http $code)"
else
  echo "push-web-data: GITHUB_DISPATCH_TOKEN unset; relying on scheduled rebuild"
fi
