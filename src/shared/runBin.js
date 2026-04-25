const Fs = require('fs-extra');
const Path = require('path');
const { pruneOldAssets } = require('./cleanup');
const history = require('./history');

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
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { setup, writeDryRunAsset, runBin };
