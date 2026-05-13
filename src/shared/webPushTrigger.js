// Cross-module signal: "this run posted something new to Bluesky, kick the
// cta-alert-history pages-repo push so the public dashboard isn't waiting on
// the 7-minute cron." Tracked as a single process-local flag — every post
// helper in shared/bluesky sets it after a successful Bluesky API call.
//
// runBin (src/shared/runBin.js) calls `flushPendingWebPush()` after the
// script's main() resolves; if the flag was set the trigger spawns
// bin/push-web-data.sh detached and lets it run in the background. The
// detached process keeps running after the bin script exits.
//
// We don't add a lock here: cron may invoke push-web-data.sh at the same
// minute boundary, and git's own .git/index.lock serializes concurrent
// commits. If a push races and loses the push-to-remote, the next cron
// tick (or the next detection) picks it up. The win is the typical case:
// a single detection now lands on the dashboard in ~30 s instead of
// waiting for the next */7 cron mark.

const Path = require('node:path');
const ChildProcess = require('node:child_process');
const Fs = require('node:fs');

const SCRIPT = Path.resolve(__dirname, '..', '..', 'bin', 'push-web-data.sh');

let pending = false;

function markWebPushPending() {
  pending = true;
}

// Spawn push-web-data.sh detached. Stdout/stderr go to the same log file
// the cron entry uses (set via PUSH_WEB_LOG; defaults to a sibling of the
// script). On any setup error we swallow it — the next cron tick will run
// the same script, so a missed manual trigger isn't fatal.
function flushPendingWebPush() {
  if (!pending) return false;
  pending = false;
  try {
    if (!Fs.existsSync(SCRIPT)) {
      console.warn(`webPushTrigger: ${SCRIPT} missing, cron will catch up`);
      return false;
    }
    const logPath =
      process.env.PUSH_WEB_LOG ||
      Path.resolve(__dirname, '..', '..', 'cron', 'push-web-data-trigger.log');
    let stdio = 'ignore';
    try {
      Fs.mkdirSync(Path.dirname(logPath), { recursive: true });
      const fd = Fs.openSync(logPath, 'a');
      stdio = ['ignore', fd, fd];
    } catch (_e) {
      // Log dir not writable — fall back to discarding output rather than
      // failing the trigger entirely.
    }
    const child = ChildProcess.spawn('/bin/sh', [SCRIPT], {
      detached: true,
      stdio,
      env: process.env,
    });
    child.unref();
    console.log(`webPushTrigger: spawned push-web-data.sh (pid=${child.pid})`);
    return true;
  } catch (e) {
    console.warn(`webPushTrigger: spawn failed: ${e.message}`);
    return false;
  }
}

module.exports = { markWebPushPending, flushPendingWebPush };
