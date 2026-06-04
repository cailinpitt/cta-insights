#!/bin/bash
# Usage: cron-run.sh <log-name> <script> [args...]
# Runs `node <script> <args...>` from the repo root, appending stamped output
# to cron/<log-name>-cron.log. Exists so crontab entries don't each repeat the
# cd/printf/redirect boilerplate.
set -e
cd "$(dirname "$0")/.."
NAME=$1
SCRIPT=$2
shift 2
LOG=cron/$NAME-cron.log
printf "\n\n=== $(date) $NAME ===\n" >> "$LOG"

# Relax -e around the job + ping so a non-zero exit still pings (with status)
# instead of aborting the wrapper before the heartbeat is sent.
set +e
/usr/bin/node "$SCRIPT" "$@" >> "$LOG" 2>&1
rc=$?

# Optional heartbeat ping to the cta-heartbeat Worker. No-op unless
# cron/heartbeat.env exists (see cron/heartbeat.env.example). -m caps curl so a
# hung ping never wedges the cron slot; the ping is never fatal to the job.
[ -f cron/heartbeat.env ] && . cron/heartbeat.env
if [ -n "$HB_PING_URL" ]; then
  st=$([ "$rc" -eq 0 ] && echo ok || echo fail)
  curl -fsS -m 10 --retry 2 -X POST \
    -H "Authorization: Bearer $HB_PING_TOKEN" \
    "$HB_PING_URL/ping/$NAME?status=$st" >/dev/null 2>&1 || true
fi

exit $rc
