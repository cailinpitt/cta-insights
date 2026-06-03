#!/bin/bash
# Daily off-box backup of the cta-insights history DB to Cloudflare R2.
#
# Uses SQLite's online `.backup` (WAL-safe — produces a single consistent
# file with the WAL merged in, without blocking the bots mid-write). The
# snapshot is integrity-checked, gzipped (~4-5x), and shipped to R2 via
# rclone. A couple of local copies are kept under tmp/ for fast restores.
#
# One-time setup (install rclone, create the bucket + token, configure the
# `r2` remote) is documented in docs/BACKUPS.md. Run from anywhere:
#
#   scripts/backup-db.sh
#
# Env overrides:
#   RCLONE_REMOTE   rclone "remote:bucket" target   (default: r2:cta-insights-db-backups)
#   KEEP_LOCAL      local snapshots to retain        (default: 2)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_DIR/state/history.sqlite"
WORKDIR="$REPO_DIR/tmp/db-backups"
REMOTE="${RCLONE_REMOTE:-r2:cta-insights-db-backups}"
KEEP_LOCAL="${KEEP_LOCAL:-2}"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="history-${STAMP}.sqlite"

if [ ! -f "$DB" ]; then
  echo "$(date -Is) ERROR: DB not found at $DB" >&2
  exit 1
fi

mkdir -p "$WORKDIR"

# 1. Consistent online snapshot (merges the WAL; safe while writers run).
sqlite3 "$DB" ".backup '${WORKDIR}/${OUT}'"

# 2. Verify the snapshot before trusting it — a corrupt backup is worse than
#    none because it hides the fact that you're unprotected.
if ! sqlite3 "${WORKDIR}/${OUT}" 'PRAGMA integrity_check;' | grep -qx 'ok'; then
  echo "$(date -Is) ERROR: integrity_check failed for ${OUT}" >&2
  rm -f "${WORKDIR}/${OUT}"
  exit 1
fi

# 3. Compress.
gzip -f "${WORKDIR}/${OUT}"

# 4. Ship off-box. --s3-no-check-bucket avoids needing ListBuckets on the token.
rclone copy "${WORKDIR}/${OUT}.gz" "${REMOTE}/" --s3-no-check-bucket

# 5. Prune local temp copies (keep newest $KEEP_LOCAL).
ls -1t "${WORKDIR}"/history-*.sqlite.gz 2>/dev/null \
  | tail -n +"$((KEEP_LOCAL + 1))" \
  | xargs -r rm -f

echo "$(date -Is) backup ok: ${OUT}.gz -> ${REMOTE}"
