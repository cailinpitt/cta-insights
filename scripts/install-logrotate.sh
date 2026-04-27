#!/bin/bash
# Install/update the cta-bot logrotate config under /etc/logrotate.d/.
# Detects the owner of the local cron/ directory and substitutes it into
# the template so the repo file stays user-agnostic.
#
# Run on the server: sudo scripts/install-logrotate.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_DIR/cron/logrotate.conf"
CRON_LOG_DIR="$REPO_DIR/cron"
DEST="/etc/logrotate.d/cta-bot"

if [ ! -f "$SRC" ]; then
  echo "Source template missing: $SRC" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run as root (use sudo)." >&2
  exit 1
fi

# Detect the user/group that owns the cron log directory — that's who
# logrotate must drop privileges to.
SU_USER="$(stat -c '%U' "$CRON_LOG_DIR")"
SU_GROUP="$(stat -c '%G' "$CRON_LOG_DIR")"

if [ -z "$SU_USER" ] || [ -z "$SU_GROUP" ]; then
  echo "Could not determine owner of $CRON_LOG_DIR" >&2
  exit 1
fi

echo "Substituting CRON_LOG_DIR=$CRON_LOG_DIR SU_USER=$SU_USER SU_GROUP=$SU_GROUP"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
sed \
  -e "s|CRON_LOG_DIR|${CRON_LOG_DIR}|g" \
  -e "s|SU_USER|${SU_USER}|g" \
  -e "s|SU_GROUP|${SU_GROUP}|g" \
  "$SRC" > "$TMP"

install -m 0644 "$TMP" "$DEST"
echo "Installed $DEST"

# Validate by running logrotate in debug mode — surfaces parse errors without
# rotating anything.
logrotate -d "$DEST"
echo "OK — logrotate parsed the config cleanly."
echo "System cron will pick it up on the next daily run (usually overnight)."
