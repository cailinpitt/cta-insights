const Path = require('node:path');
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
  } catch (_e) {
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
    if (delta < bestDelta) {
      best = s;
      bestDelta = delta;
    }
  }
  return best;
}

function normalizeStopName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens we expect to be incidental noise in headlines vs. official stop names.
// "Belmont/Halsted" (headline) vs "Belmont & Halsted" (stop). Normalize both.
function canonicalizeJunction(name) {
  return normalizeStopName(name).replace(/\s*[/&]\s*/g, ' & ');
}

// Search a list of pids for a stop matching `stopName`. Tiered:
//   1. exact normalized match
//   2. junction-canonicalized match ('/' ↔ '&')
//   3. substring containment (either direction) so "Belmont/Halsted" still
//      finds "Belmont & Halsted" if junction form differs.
// Returns first match {pid, pdist, stopName} or null.
async function resolveStopOnRoute({ pids, loadPattern: load, stopName }) {
  if (!pids?.length || !stopName) return null;
  const loader = load || loadPattern;
  const targetNorm = normalizeStopName(stopName);
  const targetCanon = canonicalizeJunction(stopName);
  if (!targetNorm) return null;

  for (const pid of pids) {
    let pattern;
    try {
      pattern = await loader(pid);
    } catch (_e) {
      continue;
    }
    const stops = (pattern?.points || []).filter((p) => p.type === 'S' && p.stopName);
    // tier 1
    for (const s of stops) {
      if (normalizeStopName(s.stopName) === targetNorm) {
        return { pid: String(pid), pdist: s.pdist, stopName: s.stopName };
      }
    }
    // tier 2
    for (const s of stops) {
      if (canonicalizeJunction(s.stopName) === targetCanon) {
        return { pid: String(pid), pdist: s.pdist, stopName: s.stopName };
      }
    }
    // tier 3 (substring)
    for (const s of stops) {
      const sNorm = normalizeStopName(s.stopName);
      if (sNorm.includes(targetNorm) || targetNorm.includes(sNorm)) {
        return { pid: String(pid), pdist: s.pdist, stopName: s.stopName };
      }
    }
  }
  return null;
}

module.exports = {
  loadPattern,
  findNearestStop,
  patternSignature,
  resolveStopOnRoute,
  normalizeStopName,
};
