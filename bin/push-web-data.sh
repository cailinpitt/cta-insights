#!/bin/sh
# Push updated alert data to the GitHub Pages repo.
# Only commits when the data actually changed.
#
# Env (auto-detected when the two repos are siblings):
#   CTA_INSIGHTS — path to this repo clone (default: the directory this
#                  script lives in, walked up one level)
#   PAGES_REPO   — path to the cta-alert-history clone (default: sibling
#                  of CTA_INSIGHTS, falling back to ~/cta-alert-history)
#
# Auto-detection matters because src/shared/webPushTrigger.js spawns this
# script from inside a Node bin run on detection — the cron line's
# PAGES_REPO= prefix isn't inherited there, so a "must set env" default
# would silently skip the manual trigger.

set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CTA_INSIGHTS="${CTA_INSIGHTS:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [ -z "$PAGES_REPO" ]; then
  if [ -d "$CTA_INSIGHTS/../cta-alert-history/.git" ]; then
    PAGES_REPO=$(cd "$CTA_INSIGHTS/../cta-alert-history" && pwd)
  else
    PAGES_REPO="$HOME/cta-alert-history"
  fi
fi

cd "$PAGES_REPO"
git pull --quiet

node "$CTA_INSIGHTS/bin/export-web.js" public/data/alerts.json
node "$CTA_INSIGHTS/bin/export-daily.js" public/data/daily-counts.json

# Commit if either file is modified or newly created. `git status --porcelain`
# catches both cases (`git diff --quiet` would miss the first-ever creation of
# daily-counts.json since untracked files don't show up in the diff).
if [ -z "$(git status --porcelain public/data/alerts.json public/data/daily-counts.json)" ]; then
  echo "push-web-data: no changes, skipping commit"
  exit 0
fi

git add public/data/alerts.json public/data/daily-counts.json
git -c user.name="cta-bot" -c user.email="cta-bot@users.noreply.github.com" \
  commit -m "data: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push
echo "push-web-data: pushed"
