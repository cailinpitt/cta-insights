const { getAllTrainPositions } = require('./trainApi');
const { haversineFt, cumulativeDistances } = require('./shared/geo');


const FEET_PER_DEG_LAT = 364567;

// Default pair-sampling thresholds for train data. Trains hit 55–65 mph
// between stops on the Red/Blue lines, so the maxMph cap sits above that
// cruise speed. maxDtMs matches the bus cadence — a gap >3 min generally
// means the train vanished from the feed (tunnel, out of service).
const DEFAULT_TRAIN_SAMPLE_OPTS = {
  maxDtMs: 3 * 60 * 1000,
  maxMph: 70,
  minAlongFt: 10,
  maxPerpFt: 1000,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Shift a polyline perpendicular to its direction of travel by `offsetFt` feet.
 * Positive offset = left of travel (counter-clockwise rotation of the segment
 * tangent); negative = right. Used to render two directional speedmap ribbons
 * side-by-side on the same base line.
 *
 * Each vertex is offset along the perpendicular to the *average* of its
 * incoming and outgoing segment tangents, which keeps the offset polyline
 * continuous through bends without gaps or overlaps.
 */
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
    // Perpendicular (rotate tangent 90° CCW): (dx,dy) -> (-dy, dx).
    const perpDxFt = (-dyFt / len) * offsetFt;
    const perpDyFt = (dxFt / len) * offsetFt;
    out.push([
      lat + perpDyFt / FEET_PER_DEG_LAT,
      lon + perpDxFt / lonFt,
    ]);
  }
  return out;
}

/**
 * Snap a lat/lon point onto the nearest segment of a polyline (array of
 * [lat, lon] pairs) and return its cumulative distance along that polyline.
 *
 * Projects perpendicularly onto each segment rather than snapping to the
 * nearest vertex. With sparse polylines (e.g. CTA train lines, ~80 vertices
 * across 20 mi) vertex-snapping puts the result anywhere from hundreds to
 * thousands of feet off, which silently corrupts both bunching detection
 * (false positives when two distant trains happen to snap to vertices with
 * similar cumDist) and speedmap binning.
 */
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

/**
 * Same as snapToLine but also returns the perpendicular distance from the
 * query point to the snapped position. Used to reject samples that are far
 * from the polyline — key for branched lines (Green) where a train on the
 * Cottage Grove branch should not contribute to the Ashland/63rd branch's
 * bins just because snapToLine projects it onto the latter.
 */
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

/**
 * Build a single merged polyline and cumulative distance array for a line from
 * the trainLines segments. Most lines have a single segment; Green has two
 * branches. We pick the longest segment as the "main" line for speedmap
 * purposes — the branch with fewer trains would produce sparse data anyway.
 *
 * Round-trip polylines (Orange/Brown/Purple/Pink all start and end at the same
 * terminal) are truncated at the apex vertex — the point farthest from the
 * start by haversine distance. Without this, `snapToLine` splits each train's
 * observations between outbound and inbound branches of an identical physical
 * track: consecutive readings jump thousands of feet across branches and get
 * filtered as noise, leaving most of the route with no samples. Using the
 * one-way half means both trDr directions map onto the same polyline (the
 * physical distance from the terminal), which is what we actually want.
 */
function processSegment(seg) {
  const first = { lat: seg[0][0], lon: seg[0][1] };
  const last = { lat: seg[seg.length - 1][0], lon: seg[seg.length - 1][1] };
  const isRoundTrip = haversineFt(first, last) < 500;
  let pruned = seg;
  if (isRoundTrip) {
    // Find the apex (farthest point from terminal), then keep all trailing
    // points whose distance from the terminal stays within 90% of the apex —
    // this preserves the full Loop circuit (Orange/Brown/Pink/Purple all trace
    // ~4 corners of the elevated rectangle after reaching their apex). Stop
    // when distance drops below the plateau: that's the return leg retracing
    // outbound tracks, which we want to drop.
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

/**
 * Return all branches of a line as an array. Most lines have one branch; Green
 * has two (Harlem/Lake → Ashland/63rd and Harlem/Lake → Cottage Grove). Each
 * branch gets its own polyline, cumDist, and totalFt. Round-trip polylines are
 * still truncated at their apex — see `processSegment`.
 */
function buildLineBranches(trainLines, line) {
  const segments = trainLines[line] || [];
  return segments.map(processSegment);
}

/**
 * Back-compat wrapper returning the single longest branch. Used by
 * trainBunching / renderTrainBunching which expect one polyline.
 */
function buildLinePolyline(trainLines, line) {
  const branches = buildLineBranches(trainLines, line);
  if (branches.length === 0) return { points: [], cumDist: [] };
  let best = branches[0];
  for (const b of branches) {
    if (b.points.length > best.points.length) best = b;
  }
  return best;
}

/**
 * Poll train positions for a specific line at fixed intervals and return
 * per-train tracks keyed by run number and direction.
 */
async function collectTrains(line, durationMs, pollIntervalMs) {
  const tracks = new Map(); // rn -> Map<trDr, [{t, lat, lon}, ...]>
  const destByRnDir = new Map(); // rn -> Map<trDr, destination>
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

/**
 * Derive per-direction speed samples from collected train tracks by snapping
 * each position onto the line polyline to get a distance-along-route. Also
 * returns which rns contributed to each direction so callers can look up
 * per-direction destinations from raw train data.
 *
 * `maxPerpFt` keeps branched-line bins (Green's Ashland vs Cottage Grove) from
 * cross-contaminating: a train on the other branch projects onto this
 * polyline from thousands of feet away and gets dropped.
 */
function computeTrainSamples(tracks, linePoints, cumDist, opts = {}) {
  const { maxDtMs, maxMph, minAlongFt, maxPerpFt } = { ...DEFAULT_TRAIN_SAMPLE_OPTS, ...opts };
  const byDir = new Map(); // trDr -> [{pdist, mph}, ...]
  const rnsByDir = new Map(); // trDr -> Set<rn>
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

        const midPdist = (s1.cumDist + s2.cumDist) / 2;
        if (!byDir.has(trDr)) byDir.set(trDr, []);
        byDir.get(trDr).push({ pdist: midPdist, mph });
        if (!rnsByDir.has(trDr)) rnsByDir.set(trDr, new Set());
        rnsByDir.get(trDr).add(rn);
      }
    }
  }

  return { byDir, rnsByDir, stats };
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

// Inverse of `snapToLine`: given a cumulative-distance position along the
// polyline, return the {lat, lon} on the line at that distance. Used to
// render a train at its snapped/clamped position rather than raw GPS.
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

module.exports = {
  collectTrains,
  computeTrainSamples,
  pickTargetDir,
  buildLinePolyline,
  buildLineBranches,
  snapToLine,
  pointAlongLine,
  offsetPolyline,
};
