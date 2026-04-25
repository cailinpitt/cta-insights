const { getAllTrainPositions } = require('./api');
const { haversineFt, cumulativeDistances } = require('../shared/geo');


const FEET_PER_DEG_LAT = 364567;

// 70 mph cap covers the 55–65 cruise speed on Red/Blue. >3 min dt usually
// means the train vanished from the feed (tunnel / out of service).
const DEFAULT_TRAIN_SAMPLE_OPTS = {
  maxDtMs: 3 * 60 * 1000,
  maxMph: 70,
  minAlongFt: 10,
  maxPerpFt: 1000,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Positive offset = left of travel; negative = right. Each vertex offsets
// along the perpendicular to the AVERAGE of incoming/outgoing tangents, which
// keeps the offset polyline continuous through bends without gaps.
function offsetPolyline(points, offsetFt) {
  const feetPerDegLon = (lat) => FEET_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const [lat, lon] = points[i];
    let dLat = 0;
    let dLon = 0;
    if (i > 0) {
      dLat += lat - points[i - 1][0];
      dLon += lon - points[i - 1][1];
    }
    if (i < points.length - 1) {
      dLat += points[i + 1][0] - lat;
      dLon += points[i + 1][1] - lon;
    }
    const lonFt = feetPerDegLon(lat);
    const dxFt = dLon * lonFt;
    const dyFt = dLat * FEET_PER_DEG_LAT;
    const len = Math.sqrt(dxFt * dxFt + dyFt * dyFt);
    if (len === 0) { out.push([lat, lon]); continue; }
    // Perpendicular = tangent rotated 90° CCW: (dx,dy) → (-dy, dx).
    const perpDxFt = (-dyFt / len) * offsetFt;
    const perpDyFt = (dxFt / len) * offsetFt;
    out.push([
      lat + perpDyFt / FEET_PER_DEG_LAT,
      lon + perpDxFt / lonFt,
    ]);
  }
  return out;
}

// Perpendicular projection (not vertex-snap). With CTA's sparse train
// polylines (~80 vertices over 20 mi), vertex-snapping would put the result
// hundreds-to-thousands of feet off, breaking bunching and speedmap binning.
function snapToLine(lat, lon, linePoints, cumDist) {
  let bestDist = Infinity;
  let bestCum = 0;
  for (let i = 0; i < linePoints.length - 1; i++) {
    const ax = linePoints[i][1];
    const ay = linePoints[i][0];
    const bx = linePoints[i + 1][1];
    const by = linePoints[i + 1][0];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, ((lon - ax) * dx + (lat - ay) * dy) / lenSq));
    const projLat = ay + t * dy;
    const projLon = ax + t * dx;
    const d = haversineFt({ lat, lon }, { lat: projLat, lon: projLon });
    if (d < bestDist) {
      bestDist = d;
      const segLen = cumDist[i + 1] - cumDist[i];
      bestCum = cumDist[i] + t * segLen;
    }
  }
  return bestCum;
}

// perpDist enables off-branch rejection: a train on Green's Cottage Grove
// branch projects onto the Ashland/63rd polyline from far away.
function snapToLineWithPerp(lat, lon, linePoints, cumDist) {
  let bestDist = Infinity;
  let bestCum = 0;
  for (let i = 0; i < linePoints.length - 1; i++) {
    const ax = linePoints[i][1];
    const ay = linePoints[i][0];
    const bx = linePoints[i + 1][1];
    const by = linePoints[i + 1][0];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, ((lon - ax) * dx + (lat - ay) * dy) / lenSq));
    const projLat = ay + t * dy;
    const projLon = ax + t * dx;
    const d = haversineFt({ lat, lon }, { lat: projLat, lon: projLon });
    if (d < bestDist) {
      bestDist = d;
      const segLen = cumDist[i + 1] - cumDist[i];
      bestCum = cumDist[i] + t * segLen;
    }
  }
  return { cumDist: bestCum, perpDist: bestDist };
}

// Round-trip polylines (Orange/Brown/Purple/Pink end at their start) are
// truncated at the apex — both trDr directions map onto the same outbound
// polyline. Without this, `snapToLine` splits observations between outbound
// and inbound branches over identical track and most samples get noise-filtered.
function processSegment(seg) {
  const first = { lat: seg[0][0], lon: seg[0][1] };
  const last = { lat: seg[seg.length - 1][0], lon: seg[seg.length - 1][1] };
  const isRoundTrip = haversineFt(first, last) < 500;
  let pruned = seg;
  if (isRoundTrip) {
    // Keep apex + plateau (the Loop's elevated rectangle), drop the return leg
    // retracing outbound tracks. Plateau threshold = 90% of apex distance.
    const dists = seg.map(([lat, lon]) => haversineFt(first, { lat, lon }));
    let apexIdx = 0;
    for (let i = 1; i < dists.length; i++) {
      if (dists[i] > dists[apexIdx]) apexIdx = i;
    }
    const plateauThreshold = dists[apexIdx] * 0.9;
    let exitIdx = seg.length - 1;
    for (let i = apexIdx + 1; i < dists.length; i++) {
      if (dists[i] < plateauThreshold) {
        exitIdx = i - 1;
        break;
      }
    }
    pruned = seg.slice(0, exitIdx + 1);
  }

  const points = pruned.map((p) => ({ lat: p[0], lon: p[1] }));
  const cumDist = cumulativeDistances(points);
  return { points: pruned, cumDist, totalFt: cumDist[cumDist.length - 1] };
}

function buildLineBranches(trainLines, line) {
  const segments = trainLines[line] || [];
  return segments.map(processSegment);
}

function buildLinePolyline(trainLines, line) {
  const branches = buildLineBranches(trainLines, line);
  if (branches.length === 0) return { points: [], cumDist: [] };
  let best = branches[0];
  for (const b of branches) {
    if (b.points.length > best.points.length) best = b;
  }
  return best;
}

async function collectTrains(line, durationMs, pollIntervalMs) {
  const tracks = new Map();
  const destByRnDir = new Map();
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
        if (t.destination) {
          if (!destByRnDir.has(t.rn)) destByRnDir.set(t.rn, new Map());
          destByRnDir.get(t.rn).set(t.trDr, t.destination);
        }
      }
      const elapsedMin = ((Date.now() - start) / 60000).toFixed(1);
      console.log(`[t+${elapsedMin}m] poll ${pollCount}: ${trains.length} trains`);
    } catch (err) {
      console.log(`Poll error: ${err.message}`);
    }
    const elapsed = Date.now() - tickStart;
    await sleep(Math.max(0, pollIntervalMs - elapsed));
  }
  return { tracks, destByRnDir };
}

// `maxPerpFt` rejects off-branch projections (Green Ashland vs Cottage Grove).
function computeTrainSamples(tracks, linePoints, cumDist, opts = {}) {
  const { maxDtMs, maxMph, minAlongFt, maxPerpFt } = { ...DEFAULT_TRAIN_SAMPLE_OPTS, ...opts };
  const byDir = new Map();
  const rnsByDir = new Map();
  const stats = { offLine: 0, stationary: 0, dropped: 0 };

  for (const [rn, byDirForTrain] of tracks) {
    for (const [trDr, positions] of byDirForTrain) {
      positions.sort((a, b) => a.t - b.t);
      for (let i = 1; i < positions.length; i++) {
        const p1 = positions[i - 1];
        const p2 = positions[i];
        const dt = p2.t - p1.t;
        if (dt <= 0 || dt > maxDtMs) { stats.dropped++; continue; }

        const s1 = snapToLineWithPerp(p1.lat, p1.lon, linePoints, cumDist);
        const s2 = snapToLineWithPerp(p2.lat, p2.lon, linePoints, cumDist);
        if (s1.perpDist > maxPerpFt || s2.perpDist > maxPerpFt) { stats.offLine++; continue; }

        const dft = Math.abs(s2.cumDist - s1.cumDist);
        if (dft < minAlongFt) { stats.stationary++; continue; }
        const mph = (dft / (dt / 1000)) * (3600 / 5280);
        if (mph > maxMph) { stats.dropped++; continue; }

        const startFt = Math.min(s1.cumDist, s2.cumDist);
        const endFt = Math.max(s1.cumDist, s2.cumDist);
        if (!byDir.has(trDr)) byDir.set(trDr, []);
        byDir.get(trDr).push({ startFt, endFt, mph });
        if (!rnsByDir.has(trDr)) rnsByDir.set(trDr, new Set());
        rnsByDir.get(trDr).add(rn);
      }
    }
  }

  return { byDir, rnsByDir, stats };
}

function pickTargetDir(samplesByDir) {
  let best = null;
  for (const [trDr, samples] of samplesByDir) {
    if (!best || samples.length > best.count) best = { trDr, count: samples.length };
  }
  return best?.trDr;
}

// Inverse of snapToLine — used to render trains at their snapped (vs raw GPS) position.
function pointAlongLine(linePoints, cumDist, dist) {
  if (linePoints.length === 0) return null;
  if (dist <= cumDist[0]) return { lat: linePoints[0][0], lon: linePoints[0][1] };
  const last = linePoints.length - 1;
  if (dist >= cumDist[last]) return { lat: linePoints[last][0], lon: linePoints[last][1] };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= dist) lo = mid;
    else hi = mid;
  }
  const span = cumDist[hi] - cumDist[lo];
  const t = span === 0 ? 0 : (dist - cumDist[lo]) / span;
  const a = linePoints[lo];
  const b = linePoints[hi];
  return { lat: a[0] + t * (b[0] - a[0]), lon: a[1] + t * (b[1] - a[1]) };
}

// Used for Purple's shuttle-only polyline (Linden↔Howard) when express isn't running.
function truncateBranchToDistance(branch, maxDistFt) {
  const { points, cumDist } = branch;
  const kept = [];
  const keptDist = [];
  for (let i = 0; i < points.length; i++) {
    if (cumDist[i] <= maxDistFt) {
      kept.push(points[i]);
      keptDist.push(cumDist[i]);
      continue;
    }
    if (i > 0) {
      const a = points[i - 1];
      const b = points[i];
      const span = cumDist[i] - cumDist[i - 1];
      const t = span === 0 ? 0 : (maxDistFt - cumDist[i - 1]) / span;
      kept.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      keptDist.push(maxDistFt);
    }
    break;
  }
  return { points: kept, cumDist: keptDist, totalFt: keptDist[keptDist.length - 1] };
}

module.exports = {
  collectTrains,
  computeTrainSamples,
  pickTargetDir,
  buildLinePolyline,
  buildLineBranches,
  snapToLine,
  snapToLineWithPerp,
  pointAlongLine,
  offsetPolyline,
  truncateBranchToDistance,
};
