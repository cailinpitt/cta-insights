const Os = require('os');
const Path = require('path');
const Fs = require('fs-extra');

const ASSETS_DIR = Path.join(__dirname, '..', 'assets');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;  // 1 day

// Tmpdir prefixes used by the video capture modules. The normal path cleans
// up with a `finally` block, but a SIGKILL or crash mid-capture leaks the
// directory — hence this startup sweep.
const TMP_PREFIXES = ['cta-bunch-video-', 'cta-train-video-'];

/**
 * Prune files in assets/ older than MAX_AGE_MS. Real-post paths don't write to
 * disk, so this only affects dry-run artifacts from testing.
 */
function pruneOldAssets() {
  if (Fs.existsSync(ASSETS_DIR)) {
    const now = Date.now();
    for (const entry of Fs.readdirSync(ASSETS_DIR)) {
      const full = Path.join(ASSETS_DIR, entry);
      const stat = Fs.statSync(full);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > MAX_AGE_MS) Fs.removeSync(full);
    }
  }
  pruneLeakedTmpDirs();
}

/**
 * Sweep leaked cta-*-video-* tmpdirs older than TMP_MAX_AGE_MS. A crashed or
 * SIGKILL'd video capture leaves these behind; normal completion removes them
 * in the capture module's finally block.
 */
function pruneLeakedTmpDirs() {
  const tmp = Os.tmpdir();
  const now = Date.now();
  let entries;
  try {
    entries = Fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!TMP_PREFIXES.some((p) => entry.startsWith(p))) continue;
    const full = Path.join(tmp, entry);
    try {
      const stat = Fs.statSync(full);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs > TMP_MAX_AGE_MS) Fs.removeSync(full);
    } catch {
      // Another process may have cleaned it up; ignore.
    }
  }
}

module.exports = { pruneOldAssets };
