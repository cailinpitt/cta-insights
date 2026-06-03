#!/bin/bash
# Restore a history DB snapshot from Cloudflare R2.
#
# A backup you've never restored is a guess, not a backup — run this
# periodically to prove the chain works end to end.
#
# Usage:
#   scripts/restore-db.sh --list                 # list available snapshots
#   scripts/restore-db.sh                         # fetch the latest snapshot
#   scripts/restore-db.sh history-20260603-041700.sqlite.gz   # a specific one
#
# By design this NEVER overwrites the live DB. It downloads, decompresses,
# and integrity-checks into tmp/db-backups/, then prints the path and the
# manual swap-in steps. Swapping the live DB is a deliberate, stop-the-bots
# operation you do by hand.
#
# Env overrides:
#   RCLONE_REMOTE   rclone "remote:bucket"   (default: r2:cta-insights-db-backups)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="$REPO_DIR/tmp/db-backups"
REMOTE="${RCLONE_REMOTE:-r2:cta-insights-db-backups}"

if [ "${1:-}" = "--list" ]; then
  rclone lsf "${REMOTE}/" | sort
  exit 0
fi

mkdir -p "$WORKDIR"

NAME="${1:-}"
if [ -z "$NAME" ]; then
  # No name given — pick the lexicographically last, which is the newest
  # because filenames are timestamped YYYYMMDD-HHMMSS.
  NAME="$(rclone lsf "${REMOTE}/" | sort | tail -1)"
  if [ -z "$NAME" ]; then
    echo "ERROR: no snapshots found in ${REMOTE}" >&2
    exit 1
  fi
  echo "Latest snapshot: $NAME"
fi

rclone copy "${REMOTE}/${NAME}" "$WORKDIR/" --s3-no-check-bucket

GZ="$WORKDIR/$NAME"
RESTORED="${GZ%.gz}"
gunzip -kf "$GZ"

if ! sqlite3 "$RESTORED" 'PRAGMA integrity_check;' | grep -qx 'ok'; then
  echo "ERROR: restored snapshot failed integrity_check: $RESTORED" >&2
  exit 1
fi

echo
echo "Restored + verified: $RESTORED"
echo
echo "To swap it in as the live DB:"
echo "  1. Stop the writers (comment out the CTA-INSIGHTS cron block, or"
echo "     'crontab -e' and remove it temporarily)."
echo "  2. cp \"$RESTORED\" \"$REPO_DIR/state/history.sqlite\""
echo "     (this also discards the stale -wal/-shm; delete them if present)."
echo "  3. Re-enable cron."
