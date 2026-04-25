// Dead-segment ("service pulse") detector.
//
// The question: "Is there a stretch of a line where no train has appeared in
// long enough that something is probably wrong?"
//
// Approach:
//   1. Snap every train position observed in the last `lookbackMs` onto every
//      branch of the line. Use perpendicular distance to reject trains on a
//      different branch from contaminating this one.
//   2. Bin each branch into equal-length segments (e.g. 0.25 mi).
//   3. For each bin, find the most recent ts at which any train was observed
//      in that bin.
//   4. A bin is "cold" if (now - lastSeen) > max(2 × headwayMin × 60000, 15min).
//      Bins with no observations at all in the lookback window are also cold.
//   5. Find the longest contiguous run of cold bins on each branch.
//   6. A run qualifies as a candidate disruption if:
//        - It covers ≥ `minLengthFt` (default 2 mi / 10560 ft), AND
//        - It doesn't touch either end of the branch (terminal zone exclusion).
//   7. Resolve the run's (loFt, hiFt) to station names by finding the upstream
//      and downstream stations — these become the Disruption's from/to.
//
// The detector is pure — no DB writes, no cooldown acquires. Persistence
// gating (same segment for ≥ N consecutive ticks) belongs in the bin script,
// which owns pulse_state.
//
// Exported shape per candidate:
//   {
//     line, direction,
//     runLoFt, runHiFt,
//     fromStation: { name, lat, lon },
//     toStation:   { name, lat, lon },
//     coldBins, totalBins,
//     observedTrainsInWindow,
//   }
// `direction` is 'all' for loop lines, otherwise 'inbound'/'outbound' derived
// from trDr. We aggregate by branch, not direction, for loop lines because
// all trDrs share the loop. For bidirectional lines we still aggregate by
// branch: a dead segment doesn't care which way trains were going.

const { buildLineBranches, snapToLineWithPerp } = require('./speedmap');
const { terminalZoneFt } = require('../shared/geo');

const MAX_PERP_FT = 1500;       // rejecting off-branch projections
const DEFAULT_LOOKBACK_MS = 20 * 60 * 1000;
const DEFAULT_BIN_FT = 1320;    // 0.25 mi
const DEFAULT_MIN_RUN_FT = 10560; // 2 mi
const DEFAULT_MIN_COLD_MS = 15 * 60 * 1000;

/**
 * Compute dead-segment candidates for a single line.
 *
 * @param {Object} args
 * @param {string} args.line — internal line code
 * @param {Array}  args.observations — rows from observations table
 *     ({ts, direction, vehicle_id, destination}) — must be train obs for this line
 * @param {Object} args.trainLines — loaded trainLines.json
 * @param {Array}  args.stations — loaded trainStations.json
 * @param {number} args.headwayMin — scheduled line headway in minutes (for cold threshold)
 * @param {number} args.now — current epoch ms
 * @param {Object} [args.opts] — overrides for thresholds
 * @returns {Array} candidate disruptions
 */
function detectDeadSegments({ line, observations, trainLines, stations, headwayMin, now, opts = {} }) {
  const lookbackMs = opts.lookbackMs || DEFAULT_LOOKBACK_MS;
  const binFt = opts.binFt || DEFAULT_BIN_FT;
  const minRunFt = opts.minRunFt || DEFAULT_MIN_RUN_FT;
  // Cold threshold: scaled by headway, floored at 15 min. On a 5-min-headway
  // line 2× headway is 10 min (too aggressive); floor keeps short-headway
  // lines from firing on routine spacing variance.
  const coldThresholdMs = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? 2 * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );

  const branches = buildLineBranches(trainLines, line);
  if (branches.length === 0) return [];

  // We need lat/lon from observations. The `observations` table doesn't store
  // position — only ts/vid/direction/destination. For the dead-segment test
  // we need positions from the *live* fetch passed in via opts.livePositions
  // (recent snapshot carrying lat/lon). Historical ts-vs-bin staleness is
  // computed using that live snapshot + the position-tagged "recent positions"
  // array (also passed via opts.recentPositions when available).
  //
  // Practically: the caller passes recentPositions — an array of
  // {ts, lat, lon, rn, trDr} — which is the aggregate of the last N polls.
  // We fall back to just the current live snapshot if history isn't provided.
  const recent = opts.recentPositions || [];
  const sinceTs = now - lookbackMs;
  const fresh = recent.filter((p) => p.ts >= sinceTs);

  const candidates = [];
  for (let branchIdx = 0; branchIdx < branches.length; branchIdx++) {
    const branch = branches[branchIdx];
    const { points, cumDist, totalFt } = branch;
    if (points.length < 2 || !totalFt) continue;

    const numBins = Math.max(2, Math.ceil(totalFt / binFt));
    const lastSeenPerBin = new Array(numBins).fill(-Infinity);
    let onBranch = 0;

    for (const p of fresh) {
      const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
      if (perpDist > MAX_PERP_FT) continue;
      onBranch++;
      const idx = Math.min(numBins - 1, Math.max(0, Math.floor(along / (totalFt / numBins))));
      if (p.ts > lastSeenPerBin[idx]) lastSeenPerBin[idx] = p.ts;
    }

    // Terminal zone: don't flag bins within the zone at either end.
    const zoneFt = terminalZoneFt(totalFt);
    const zoneBins = Math.ceil(zoneFt / (totalFt / numBins));

    const coldBefore = now - coldThresholdMs;
    const cold = lastSeenPerBin.map((ts) => ts < coldBefore);

    // Longest contiguous cold run, ignoring terminal zones.
    let bestStart = -1;
    let bestEnd = -1;
    let curStart = -1;
    for (let i = zoneBins; i < numBins - zoneBins; i++) {
      if (cold[i]) {
        if (curStart < 0) curStart = i;
        const curEnd = i;
        if (bestEnd - bestStart < curEnd - curStart) {
          bestStart = curStart;
          bestEnd = curEnd;
        }
      } else {
        curStart = -1;
      }
    }
    if (bestStart < 0) continue;

    const binLengthFt = totalFt / numBins;
    const runLoFt = bestStart * binLengthFt;
    const runHiFt = (bestEnd + 1) * binLengthFt;
    const runLengthFt = runHiFt - runLoFt;
    if (runLengthFt < minRunFt) continue;

    const stationsOnBranch = stationsAlongBranch(stations, line, points, cumDist);
    const fromStation = nearestStationAtOrBefore(stationsOnBranch, runLoFt);
    const toStation = nearestStationAtOrAfter(stationsOnBranch, runHiFt);
    if (!fromStation || !toStation) continue;
    if (fromStation.station.name === toStation.station.name) continue;

    candidates.push({
      line,
      direction: branches.length > 1 ? `branch-${branchIdx}` : 'all',
      runLoFt,
      runHiFt,
      runLengthFt,
      fromStation: fromStation.station,
      toStation: toStation.station,
      coldBins: bestEnd - bestStart + 1,
      totalBins: numBins,
      observedTrainsInWindow: onBranch,
    });
  }

  // Worst-first by run length.
  candidates.sort((a, b) => b.runLengthFt - a.runLengthFt);
  return candidates;
}

function stationsAlongBranch(stations, line, points, cumDist) {
  const out = [];
  for (const s of stations || []) {
    if (!s.lines?.includes(line)) continue;
    const { cumDist: along, perpDist } = snapToLineWithPerp(s.lat, s.lon, points, cumDist);
    if (perpDist > MAX_PERP_FT) continue;
    out.push({ station: s, trackDist: along });
  }
  out.sort((a, b) => a.trackDist - b.trackDist);
  return out;
}

function nearestStationAtOrBefore(stationsOnBranch, ft) {
  let best = null;
  for (const s of stationsOnBranch) {
    if (s.trackDist <= ft) best = s;
    else break;
  }
  return best;
}

function nearestStationAtOrAfter(stationsOnBranch, ft) {
  for (const s of stationsOnBranch) {
    if (s.trackDist >= ft) return s;
  }
  return null;
}

module.exports = {
  detectDeadSegments,
  // exported for tests
  stationsAlongBranch,
  nearestStationAtOrBefore,
  nearestStationAtOrAfter,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_BIN_FT,
  DEFAULT_MIN_RUN_FT,
  MAX_PERP_FT,
};
