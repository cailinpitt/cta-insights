const Path = require('path');
const Fs = require('fs-extra');

const ASSETS_DIR = Path.join(__dirname, '..', 'assets');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Prune files in assets/ older than MAX_AGE_MS. Real-post paths don't write to
 * disk, so this only affects dry-run artifacts from testing.
 */
function pruneOldAssets() {
  if (!Fs.existsSync(ASSETS_DIR)) return;
  const now = Date.now();
  for (const entry of Fs.readdirSync(ASSETS_DIR)) {
    const full = Path.join(ASSETS_DIR, entry);
    const stat = Fs.statSync(full);
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs > MAX_AGE_MS) Fs.removeSync(full);
  }
}

module.exports = { pruneOldAssets };
