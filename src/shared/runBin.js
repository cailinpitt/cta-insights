const Fs = require('fs-extra');
const Path = require('node:path');
const { pruneOldAssets } = require('./cleanup');
const history = require('./history');
const { flushPendingWebPush } = require('./webPushTrigger');

const ASSETS_DIR = Path.join(__dirname, '..', '..', 'assets');

function setup() {
  pruneOldAssets();
  history.rolloffOld();
}

function writeDryRunAsset(buffer, filename) {
  const outPath = Path.join(ASSETS_DIR, filename);
  Fs.ensureDirSync(Path.dirname(outPath));
  Fs.writeFileSync(outPath, buffer);
  return outPath;
}

function runBin(main) {
  // --check verifies imports resolved (CI smoke test — no env vars / network needed).
  if (process.argv.includes('--check')) {
    console.log('OK: imports resolved');
    return;
  }
  main()
    .then(() => {
      // If this run produced any new Bluesky posts (detection, alert, or
      // resolution), kick the cta-alert-history pages-repo push directly
      // so the public dashboard isn't stuck waiting for the next */7 cron
      // tick. push-web-data.sh is spawned detached — node exits as soon as
      // main resolves, even though the git ops keep running in the
      // background. The cron job is still authoritative for the steady
      // state; this just shortens latency on the active-incident path.
      flushPendingWebPush();
    })
    .catch((e) => {
      console.error(e.stack || e);
      // Still try to flush on error — a post may have landed before the
      // failure, and skipping the push would leave the bot's Bluesky
      // timeline ahead of the public dashboard for up to 7 minutes.
      try {
        flushPendingWebPush();
      } catch (_e) {}
      process.exit(1);
    });
}

module.exports = { setup, writeDryRunAsset, runBin };
