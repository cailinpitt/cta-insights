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

# Relax -e around the job + ping so a non-zero exit still pings (with its exit
# code) instead of aborting the wrapper before the ping is sent.
set +e
/usr/bin/node "$SCRIPT" "$@" >> "$LOG" 2>&1
rc=$?

# Optional healthchecks.io ping. No-op unless cron/healthchecks.env exists (see
# cron/healthchecks.env.example). The job's exit code is sent straight to
# healthchecks (0 = success, non-zero = failure), so a job that ran but failed
# alerts too — no ok/fail branch needed here. -m caps curl so a hung ping never
# wedges the cron slot; the ping is never fatal to the job.
#
# Only the slugs in HC_MONITORED ping (and thus auto-create a healthchecks
# check). The curated set keeps us under the 20-check free tier; it's the
# committed source of truth for "what's watched" — edit it here and `git pull`
# on the server to widen/narrow coverage. Jobs not listed simply don't ping.
# (push-web-data isn't run via this wrapper; it pings from its own script.)
HC_MONITORED="observe-buses observe-trains bus-alerts bus-pulse train-alerts train-pulse bus-bunching bus-gaps bus-ghosts bus-thin-gaps train-bunching train-gaps train-ghosts bus-speedmap train-speedmap fetch-gtfs audit-alerts"
[ -f cron/healthchecks.env ] && . cron/healthchecks.env
case " $HC_MONITORED " in *" $NAME "*) hc_watched=1 ;; *) hc_watched= ;; esac
if [ -n "$HC_PING_KEY" ] && [ -n "$hc_watched" ]; then
  # ?create=1 auto-creates the check on its first ping (no-op once it exists);
  # see cron/healthchecks.env.example for tuning the auto-created defaults.
  curl -fsS -m 10 --retry 2 -X POST \
    "${HC_PING_URL:-https://hc-ping.com}/$HC_PING_KEY/$NAME/$rc?create=1" >/dev/null 2>&1 || true
fi

exit $rc
