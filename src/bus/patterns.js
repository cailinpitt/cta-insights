const Path = require('path');
const Fs = require('fs-extra');
const { getPattern } = require('./api');

const CACHE_DIR = Path.join(__dirname, '..', '..', 'data', 'patterns');
// 24h TTL so mid-week reroutes (detours, terminal moves) propagate within a day.
const TTL_MS = 24 * 60 * 60 * 1000;

// Length + first/last point — drift-detectable without re-fetching.
function patternSignature(pattern) {
  const first = pattern.points[0];
  const last = pattern.points[pattern.points.length - 1];
  return `${pattern.lengthFt}:${pattern.points.length}:${first.lat},${first.lon}:${last.lat},${last.lon}`;
}

async function loadPattern(pid) {
  Fs.ensureDirSync(CACHE_DIR);
  const cachePath = Path.join(CACHE_DIR, `${pid}.json`);
  if (Fs.existsSync(cachePath)) {
    const age = Date.now() - Fs.statSync(cachePath).mtimeMs;
    if (age < TTL_MS) return Fs.readJsonSync(cachePath);
  }
  let pattern;
  try {
    pattern = await getPattern(pid);
  } catch (e) {
    // One-shot retry — ghost detection skips the entire route if this throws.
    await new Promise((r) => setTimeout(r, 250));
    pattern = await getPattern(pid);
  }
  pattern.signature = patternSignature(pattern);
  Fs.writeJsonSync(cachePath, pattern);
  return pattern;
}

function findNearestStop(pattern, pdist) {
  const stops = pattern.points.filter((p) => p.type === 'S' && p.stopName);
  let best = stops[0];
  let bestDelta = Math.abs(stops[0].pdist - pdist);
  for (const s of stops) {
    const delta = Math.abs(s.pdist - pdist);
    if (delta < bestDelta) { best = s; bestDelta = delta; }
  }
  return best;
}

module.exports = { loadPattern, findNearestStop, patternSignature };
