const { getVehicles } = require('./cta');

const MIN_SPEED_MPH = 0;
const MAX_DT_MS = 3 * 60 * 1000; // Ignore vehicle tick pairs > 3 min apart (likely a pattern change)

/**
 * Speed color ramp. Returns a 3/6-char hex (no leading #) for Mapbox path overlays.
 * null speed (no data) returns a muted gray so empty segments still show the route.
 */
function colorForBusSpeed(mph) {
  if (mph == null) return '444';   // no data — dim gray
  if (mph < 5) return 'ff2a2a';    // red
  if (mph < 10) return 'ff8c1a';   // orange
  if (mph < 15) return 'ffd21a';   // yellow
  return '2ad17f';                 // green
}

function colorForTrainSpeed(mph) {
  if (mph == null) return '444';   // no data — dim gray
  if (mph < 5) return 'ff2a2a';    // red
  if (mph < 15) return 'ff8c1a';   // orange
  if (mph < 25) return 'ffd21a';   // yellow
  return '2ad17f';                 // green
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `getvehicles` for a route at fixed intervals and return per-vehicle tracks,
 * keyed by `vid` then `pid`. Resetting the sub-key on pid change means a single
 * vehicle that changes direction mid-window doesn't produce a bogus negative-speed
 * sample across the boundary.
 */
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

/**
 * Derive per-pid speed samples from the collected tracks.
 * A sample is a speed in mph measured between two consecutive pdist observations
 * for the same vehicle on the same pid, tagged with the midpoint pdist so we can
 * attribute it to a segment of the route.
 */
function computeSamples(tracks) {
  const byPid = new Map(); // pid -> [{pdist, mph}, ...]

  for (const byPidForVid of tracks.values()) {
    for (const [pid, points] of byPidForVid) {
      points.sort((a, b) => a.t - b.t);
      for (let i = 1; i < points.length; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];
        const dt = p2.t - p1.t;
        if (dt <= 0 || dt > MAX_DT_MS) continue;
        const dft = p2.pdist - p1.pdist;
        if (dft < 0) continue; // pattern restart or bad data
        const mph = (dft / (dt / 1000)) * (3600 / 5280);
        if (mph < MIN_SPEED_MPH || mph > 60) continue; // filter obvious nonsense
        const midPdist = (p1.pdist + p2.pdist) / 2;

        if (!byPid.has(pid)) byPid.set(pid, []);
        byPid.get(pid).push({ pdist: midPdist, mph });
      }
    }
  }

  return byPid;
}

/**
 * Pick the direction with the most speed samples. Routes are bidirectional but
 * we render one direction at a time for clarity.
 */
function pickTargetPid(samplesByPid) {
  let best = null;
  for (const [pid, samples] of samplesByPid) {
    if (!best || samples.length > best.count) best = { pid, count: samples.length };
  }
  return best?.pid;
}

/**
 * Bucket samples into N equal-length pdist segments and return the average speed
 * per bucket, or null if no samples fell in that bucket.
 */
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

/**
 * Summary stats for post text / alt text.
 */
function summarize(speeds, thresholds = { orange: 5, yellow: 10, green: 15 }) {
  const valid = speeds.filter((s) => s != null);
  if (valid.length === 0) return { avg: null, red: 0, orange: 0, yellow: 0, green: 0 };
  const avg = valid.reduce((a, v) => a + v, 0) / valid.length;
  const red = valid.filter((s) => s < 5).length;
  const orange = valid.filter((s) => s >= 5 && s < thresholds.yellow).length;
  const yellow = valid.filter((s) => s >= thresholds.yellow && s < thresholds.green).length;
  const green = valid.filter((s) => s >= thresholds.green).length;
  return { avg, red, orange, yellow, green };
}

const BUS_THRESHOLDS = { orange: 5, yellow: 10, green: 15 };
const TRAIN_THRESHOLDS = { orange: 5, yellow: 15, green: 25 };

module.exports = {
  collect,
  computeSamples,
  pickTargetPid,
  binSamples,
  summarize,
  colorForBusSpeed,
  colorForTrainSpeed,
  BUS_THRESHOLDS,
  TRAIN_THRESHOLDS,
};
