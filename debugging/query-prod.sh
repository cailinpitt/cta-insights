#!/usr/bin/env bash
# Run a READ-ONLY SQL query against prod's history.sqlite over SSH. This is the
# right way to answer "did the bot actually see X?" — the local dev DB is stale,
# and the prod DB is large (~900MB) so you usually don't want to pull the whole
# thing.
#
# Every query opens the DB with -readonly, so this can never write prod.
#
# Setup: copy debugging/config.example.sh to debugging/config.sh and fill in
# CTA_SERVER + CTA_REMOTE_DB (or export them in your shell).
#
# Usage:
#   debugging/query-prod.sh 'SELECT COUNT(*) FROM gap_events'
#   debugging/query-prod.sh "SELECT ts, ratio, near_stop FROM gap_events WHERE route='red' ORDER BY ts DESC LIMIT 10"
#   debugging/query-prod.sh --tables           # list tables
#   debugging/query-prod.sh --schema gap_events
#   debugging/query-prod.sh --recent red       # canned recent activity for a line/route
#
# Tables of interest: gap_events, ghost_events, bunching_events, meta_signals,
# disruption_events, roundup_anchors, alert_posts, observations.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Help works without config so a fork can read the docs before setting anything up.
if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  grep '^#' "$0" | grep -v '^#!' | sed 's/^#[[:space:]]\{0,1\}//'
  exit 0
fi

# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/config.sh" ] && . "$SCRIPT_DIR/config.sh"
: "${CTA_SERVER:?Set CTA_SERVER (SSH target). Copy debugging/config.example.sh to debugging/config.sh, or export it.}"
: "${CTA_REMOTE_DB:?Set CTA_REMOTE_DB (path to history.sqlite on the server). See debugging/config.example.sh.}"

run() {
  ssh "$CTA_SERVER" "sqlite3 -readonly -header -column '$CTA_REMOTE_DB' \"$1\""
}

case "$1" in
  --tables)
    run "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
    ;;
  --schema)
    tbl="${2:?usage: --schema <table>}"
    run "PRAGMA table_info($tbl);"
    ;;
  --recent)
    line="${2:?usage: --recent <line|route>}"
    echo "== gap_events (line/route=$line) =="
    run "SELECT datetime(ts/1000,'unixepoch','localtime') t, direction, ROUND(ratio,2) ratio, near_stop, posted FROM gap_events WHERE route='$line' ORDER BY ts DESC LIMIT 10;"
    echo
    echo "== meta_signals =="
    run "SELECT datetime(ts/1000,'unixepoch','localtime') t, source, ROUND(severity,2) sev, posted, detail FROM meta_signals WHERE line='$line' ORDER BY ts DESC LIMIT 15;"
    echo
    echo "== disruption_events =="
    run "SELECT datetime(ts/1000,'unixepoch','localtime') t, source, from_station, to_station, posted, resolved_ts FROM disruption_events WHERE line='$line' ORDER BY ts DESC LIMIT 10;"
    echo
    echo "== roundup_anchors =="
    run "SELECT datetime(ts/1000,'unixepoch','localtime') t, signals, resolved_ts, resolution_post_uri FROM roundup_anchors WHERE line='$line' ORDER BY ts DESC LIMIT 10;"
    ;;
  *)
    run "$1"
    ;;
esac
