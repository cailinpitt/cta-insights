const { getVehicles } = require('./api');

// 60 mph cap — above CTA's ~35 mph route ceiling, but tighter than the
// train-class 70 to reject a GPS jump past a whole block.
const DEFAULT_BUS_SAMPLE_OPTS = {
  maxDtMs: 3 * 60 * 1000,
  minMph: 0,
  maxMph: 60,
};

function colorForBusSpeed(mph) {
  if (mph == null) return '444';   // no data — dim gray
  if (mph < 5) return 'ff2a2a';    // red
  if (mph < 10) return 'ff8c1a';   // orange
  if (mph < 15) return 'ffd21a';   // yellow
  return '2ad17f';                 // green
}

// Buckets align with CTA's slow-zone categories (15/25/35 mph). Extra purple
// band sits above slow zones but below line speed; green is full-speed (~45+).
function colorForTrainSpeed(mph) {
  if (mph == null) return '444';   // no data — dim gray
  if (mph < 15) return 'ff2a2a';   // red
  if (mph < 25) return 'ff8c1a';   // orange
  if (mph < 35) return 'ffd21a';   // yellow
  if (mph < 45) return 'a855f7';   // purple
  return '2ad17f';                 // green
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Sub-keying by pid means a vehicle that changes direction mid-window doesn't
// produce a bogus negative-speed sample across the boundary.
async function collect(route, durationMs, pollIntervalMs) {
  const tracks = new Map(); // vid -> Map<pid, [{t, pdist, lat, lon}, ...]>
  const start = Date.now();
  let pollCount = 0;

  while (Date.now() - start < durationMs) {
    const tickStart = Date.now();
    try {
      const vehicles = await getVehicles([route]);
      pollCount++;
      for (const v of vehicles) {
        if (!tracks.has(v.vid)) tracks.set(v.vid, new Map());
        const byPid = tracks.get(v.vid);
        if (!byPid.has(v.pid)) byPid.set(v.pid, []);
        byPid.get(v.pid).push({ t: v.tmstmp.getTime(), pdist: v.pdist, lat: v.lat, lon: v.lon });
      }
      const elapsedMin = ((Date.now() - start) / 60000).toFixed(1);
      console.log(`[t+${elapsedMin}m] poll ${pollCount}: ${vehicles.length} vehicles`);
    } catch (err) {
      console.log(`Poll error: ${err.message}`);
    }
    const elapsed = Date.now() - tickStart;
    await sleep(Math.max(0, pollIntervalMs - elapsed));
  }
  return tracks;
}

// A sample is mph between two consecutive same-vid same-pid observations,
// tagged with the midpoint pdist for segment binning. Pattern restarts (pdist
// resets near 0) cost the boundary pair — the next pair is valid on its own.
function computeSamples(tracks, opts = {}) {
  const { maxDtMs, minMph, maxMph } = { ...DEFAULT_BUS_SAMPLE_OPTS, ...opts };
  const byPid = new Map(); // pid -> [{pdist, mph}, ...]
  const stats = { restarts: 0, dropped: 0 };

  for (const byPidForVid of tracks.values()) {
    for (const [pid, points] of byPidForVid) {
      points.sort((a, b) => a.t - b.t);
      for (let i = 1; i < points.length; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];
        const dt = p2.t - p1.t;
        if (dt <= 0 || dt > maxDtMs) { stats.dropped++; continue; }
        const dft = p2.pdist - p1.pdist;
        if (dft < 0) { stats.restarts++; continue; } // vehicle completed a loop and restarted the pattern
        const mph = (dft / (dt / 1000)) * (3600 / 5280);
        if (mph < minMph || mph > maxMph) { stats.dropped++; continue; }
        const midPdist = (p1.pdist + p2.pdist) / 2;

        if (!byPid.has(pid)) byPid.set(pid, []);
        byPid.get(pid).push({ pdist: midPdist, mph });
      }
    }
  }

  return { byPid, stats };
}

function pickTargetPid(samplesByPid) {
  let best = null;
  for (const [pid, samples] of samplesByPid) {
    if (!best || samples.length > best.count) best = { pid, count: samples.length };
  }
  return best?.pid;
}

function binSamples(samples, patternLengthFt, numBins) {
  const segLen = patternLengthFt / numBins;
  const buckets = Array.from({ length: numBins }, () => []);
  for (const s of samples) {
    const idx = Math.min(numBins - 1, Math.floor(s.pdist / segLen));
    if (idx < 0) continue;
    buckets[idx].push(s.mph);
  }
  return buckets.map((b) => (b.length === 0 ? null : b.reduce((a, v) => a + v, 0) / b.length));
}

// Length-weighted overlap binning — each segment contributes to every bin it
// intersects, weighted by overlap length. Eliminates interior no-data bins
// that midpoint-only bucketing produces on sparse polls.
function binSegments(segments, patternLengthFt, numBins) {
  const segLen = patternLengthFt / numBins;
  const sums = new Array(numBins).fill(0);
  const weights = new Array(numBins).fill(0);
  for (const s of segments) {
    const lo = Math.max(0, s.startFt);
    const hi = Math.min(patternLengthFt, s.endFt);
    if (hi <= lo) continue;
    const loIdx = Math.min(numBins - 1, Math.floor(lo / segLen));
    const hiIdx = Math.min(numBins - 1, Math.floor(hi / segLen));
    for (let i = loIdx; i <= hiIdx; i++) {
      const binLo = i * segLen;
      const binHi = binLo + segLen;
      const overlap = Math.min(hi, binHi) - Math.max(lo, binLo);
      if (overlap <= 0) continue;
      sums[i] += s.mph * overlap;
      weights[i] += overlap;
    }
  }
  return sums.map((v, i) => (weights[i] === 0 ? null : v / weights[i]));
}

// Thresholds are lower bounds of each non-red bucket (red is <orange).
// A `purple` key opts into the 5-bucket train schema; otherwise callers get
// the 4-bucket shape (purple omitted).
function summarize(speeds, thresholds = { orange: 5, yellow: 10, green: 15 }) {
  const valid = speeds.filter((s) => s != null);
  const base = thresholds.purple == null
    ? { avg: null, red: 0, orange: 0, yellow: 0, green: 0 }
    : { avg: null, red: 0, orange: 0, yellow: 0, purple: 0, green: 0 };
  if (valid.length === 0) return base;
  const avg = valid.reduce((a, v) => a + v, 0) / valid.length;
  const red = valid.filter((s) => s < thresholds.orange).length;
  const orange = valid.filter((s) => s >= thresholds.orange && s < thresholds.yellow).length;
  const yellowUpper = thresholds.purple ?? thresholds.green;
  const yellow = valid.filter((s) => s >= thresholds.yellow && s < yellowUpper).length;
  const green = valid.filter((s) => s >= thresholds.green).length;
  if (thresholds.purple == null) return { avg, red, orange, yellow, green };
  const purple = valid.filter((s) => s >= thresholds.purple && s < thresholds.green).length;
  return { avg, red, orange, yellow, purple, green };
}

const BUS_THRESHOLDS = { orange: 5, yellow: 10, green: 15 };
const TRAIN_THRESHOLDS = { orange: 15, yellow: 25, purple: 35, green: 45 };

module.exports = {
  collect,
  computeSamples,
  pickTargetPid,
  binSamples,
  binSegments,
  summarize,
  colorForBusSpeed,
  colorForTrainSpeed,
  BUS_THRESHOLDS,
  TRAIN_THRESHOLDS,
};
