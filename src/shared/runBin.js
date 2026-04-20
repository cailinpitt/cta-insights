// Tiny harness shared by bin entrypoints. Covers the repetitive boilerplate
// — asset pruning, history rolloff, dry-run image writing, and the top-level
// crash handler — without trying to abstract the detection/post flow itself,
// since each job's middle section is meaningfully different.

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
  // --check exits successfully without invoking main(). All requires at the
  // top of the bin script have already resolved by the time we get here, so
  // a typo'd import would have crashed before this point. Useful as a CI
  // smoke test — runs in milliseconds and needs no env vars or network.
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
