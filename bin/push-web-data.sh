#!/bin/sh
# Push updated alert data to the GitHub Pages repo.
# Run by cron every 15 minutes on cailin-server.
# Only commits when the data actually changed.
#
# Required env or edit defaults below:
#   PAGES_REPO  — path to the cta-alert-history clone (default: ~/cta-alert-history)
#   CTA_INSIGHTS — path to this repo clone (default: ~/cta-insights)

set -e

PAGES_REPO="${PAGES_REPO:-$HOME/cta-alert-history}"
CTA_INSIGHTS="${CTA_INSIGHTS:-$HOME/cta-insights}"

cd "$PAGES_REPO"
git pull --quiet

node "$CTA_INSIGHTS/bin/export-web.js" public/data/alerts.json

if git diff --quiet public/data/alerts.json; then
  echo "push-web-data: no changes, skipping commit"
  exit 0
fi

git add public/data/alerts.json
git commit -m "data: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push
echo "push-web-data: pushed"
