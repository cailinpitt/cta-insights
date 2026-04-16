const { getAllTrainPositions } = require('./trainApi');
const { haversineFt, cumulativeDistances } = require('./geo');


const MAX_DT_MS = 3 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Snap a lat/lon point onto the nearest segment of a polyline (array of
 * [lat, lon] pairs) and return its cumulative distance along that polyline.
 */
function snapToLine(lat, lon, linePoints, cumDist) {
  let bestDist = Infinity;
  let bestCum = 0;
  for (let i = 0; i < linePoints.length; i++) {
    const d = haversineFt({ lat, lon }, { lat: linePoints[i][0], lon: linePoints[i][1] });
    if (d < bestDist) {
      bestDist = d;
      bestCum = cumDist[i];
    }
  }
  return bestCum;
}

/**
 * Build a single merged polyline and cumulative distance array for a line from
 * the trainLines segments. Most lines have a single segment; Green has two
 * branches. We pick the longest segment as the "main" line for speedmap
 * purposes — the branch with fewer trains would produce sparse data anyway.
 */
function buildLinePolyline(trainLines, line) {
  const segments = trainLines[line] || [];
  if (segments.length === 0) return { points: [], cumDist: [] };
  // Pick the longest segment by point count (the main trunk).
  let best = segments[0];
  for (const seg of segments) {
    if (seg.length > best.length) best = seg;
  }
  const points = best.map((p) => ({ lat: p[0], lon: p[1] }));
  const cumDist = cumulativeDistances(points);
  return { points: best, cumDist, totalFt: cumDist[cumDist.length - 1] };
}

/**
 * Poll train positions for a specific line at fixed intervals and return
 * per-train tracks keyed by run number and direction.
 */
async function collectTrains(line, durationMs, pollIntervalMs) {
  const tracks = new Map(); // rn -> Map<trDr, [{t, lat, lon}, ...]>
  const start = Date.now();
  let pollCount = 0;

  while (Date.now() - start < durationMs) {
    const tickStart = Date.now();
    try {
      const trains = await getAllTrainPositions([line]);
      pollCount++;
      for (const t of trains) {
        if (!tracks.has(t.rn)) tracks.set(t.rn, new Map());
        const byDir = tracks.get(t.rn);
        if (!byDir.has(t.trDr)) byDir.set(t.trDr, []);
        byDir.get(t.trDr).push({ t: Date.now(), lat: t.lat, lon: t.lon });
      }
      const elapsedMin = ((Date.now() - start) / 60000).toFixed(1);
      console.log(`[t+${elapsedMin}m] poll ${pollCount}: ${trains.length} trains`);
    } catch (err) {
      console.log(`Poll error: ${err.message}`);
    }
    const elapsed = Date.now() - tickStart;
    await sleep(Math.max(0, pollIntervalMs - elapsed));
  }
  return tracks;
}

/**
 * Derive per-direction speed samples from collected train tracks by snapping
 * each position onto the line polyline to get a distance-along-route.
 */
function computeTrainSamples(tracks, linePoints, cumDist) {
  const byDir = new Map(); // trDr -> [{pdist, mph}, ...]

  for (const byDirForTrain of tracks.values()) {
    for (const [trDr, positions] of byDirForTrain) {
      positions.sort((a, b) => a.t - b.t);
      for (let i = 1; i < positions.length; i++) {
        const p1 = positions[i - 1];
        const p2 = positions[i];
        const dt = p2.t - p1.t;
        if (dt <= 0 || dt > MAX_DT_MS) continue;

        const d1 = snapToLine(p1.lat, p1.lon, linePoints, cumDist);
        const d2 = snapToLine(p2.lat, p2.lon, linePoints, cumDist);
        const dft = Math.abs(d2 - d1);
        if (dft < 10) continue; // stationary or barely moved
        const mph = (dft / (dt / 1000)) * (3600 / 5280);
        if (mph > 70) continue; // filter nonsense

        const midPdist = (d1 + d2) / 2;
        if (!byDir.has(trDr)) byDir.set(trDr, []);
        byDir.get(trDr).push({ pdist: midPdist, mph });
      }
    }
  }

  return byDir;
}

/**
 * Pick the direction with the most speed samples.
 */
function pickTargetDir(samplesByDir) {
  let best = null;
  for (const [trDr, samples] of samplesByDir) {
    if (!best || samples.length > best.count) best = { trDr, count: samples.length };
  }
  return best?.trDr;
}

module.exports = {
  collectTrains,
  computeTrainSamples,
  pickTargetDir,
  buildLinePolyline,
  snapToLine,
};
