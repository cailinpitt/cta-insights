#!/usr/bin/env bash
# Pull a CONSISTENT snapshot of prod's history.sqlite to a local copy, for the
# read-only replay/render harnesses (scripts/replay-pulse.js,
# scripts/replay-incident.js, scripts/render-*). The local dev
# state/history.sqlite is a stale artifact — never use it for real data; pull
# prod instead.
#
# The DB is WAL-mode and large (~900MB), so this uses sqlite3 `.backup` on the
# server to capture a transactionally-consistent snapshot (WAL folded in), then
# transfers that — a plain rsync of the live file could miss or tear recent
# commits.
#
# Setup: copy debugging/config.example.sh to debugging/config.sh and fill in
# CTA_SERVER + CTA_REMOTE_DB (or export them in your shell).
#
# Usage:
#   debugging/pull-prod-db.sh                 # -> tmp/server-history.sqlite
#   debugging/pull-prod-db.sh path/to.sqlite  # custom destination
#
# Then point a harness at it:
#   HISTORY_DB_PATH=tmp/server-history.sqlite \
#     node scripts/replay-pulse.js --line=red --start=2026-05-03T20:00Z --end=2026-05-03T22:30Z
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/config.sh" ] && . "$SCRIPT_DIR/config.sh"
: "${CTA_SERVER:?Set CTA_SERVER (SSH target). Copy debugging/config.example.sh to debugging/config.sh, or export it.}"
: "${CTA_REMOTE_DB:?Set CTA_REMOTE_DB (path to history.sqlite on the server). See debugging/config.example.sh.}"

DEST="${1:-tmp/server-history.sqlite}"
REMOTE_SNAP="/tmp/cta-history-snapshot.$$.sqlite"

mkdir -p "$(dirname "$DEST")"

echo "Snapshotting prod DB on $CTA_SERVER (consistent .backup; WAL-mode)..."
ssh "$CTA_SERVER" "sqlite3 -readonly '$CTA_REMOTE_DB' \".backup '$REMOTE_SNAP'\""

echo "Transferring snapshot -> $DEST ..."
rsync -z --progress "$CTA_SERVER:$REMOTE_SNAP" "$DEST"

echo "Cleaning up remote snapshot..."
ssh "$CTA_SERVER" "rm -f '$REMOTE_SNAP'"

echo "Done -> $DEST"
echo "Use it with:  HISTORY_DB_PATH=$DEST node scripts/replay-pulse.js ..."
