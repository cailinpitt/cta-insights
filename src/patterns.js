const Path = require('path');
const Fs = require('fs-extra');
const { getPattern } = require('./cta');

const CACHE_DIR = Path.join(__dirname, '..', 'data', 'patterns');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — long enough to avoid churn, short enough to catch reroutes

async function loadPattern(pid) {
  Fs.ensureDirSync(CACHE_DIR);
  const cachePath = Path.join(CACHE_DIR, `${pid}.json`);
  if (Fs.existsSync(cachePath)) {
    const age = Date.now() - Fs.statSync(cachePath).mtimeMs;
    if (age < TTL_MS) return Fs.readJsonSync(cachePath);
  }
  const pattern = await getPattern(pid);
  Fs.writeJsonSync(cachePath, pattern);
  return pattern;
}

module.exports = { loadPattern };
