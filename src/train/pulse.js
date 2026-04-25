// Detects dead segments on a rail line: stretches where no train has appeared
// recently enough that something is probably wrong. Pure function — no DB
// writes; persistence/cooldown gating lives in the bin script.
//
// Each branch is binned by along-track distance; a bin is "cold" when no
// train has projected into it within max(2× headway, 15 min). The longest
// contiguous cold run becomes a candidate disruption when it spans ≥ 2 mi
// and doesn't touch either terminal zone.

const { buildLineBranches, snapToLineWithPerp } = require('./speedmap');
const { terminalZoneFt } = require('../shared/geo');

const MAX_PERP_FT = 1500;       // reject projections from off-branch trains
const DEFAULT_LOOKBACK_MS = 20 * 60 * 1000;
const DEFAULT_BIN_FT = 1320;    // 0.25 mi
const DEFAULT_MIN_RUN_FT = 10560; // 2 mi
const DEFAULT_MIN_COLD_MS = 15 * 60 * 1000;
const DEFAULT_MIN_COVERAGE_FRAC = 0.5;
const DEFAULT_MIN_SPAN_FRAC = 0.5;

function detectDeadSegments({ line, observations, trainLines, stations, headwayMin, now, opts = {} }) {
  const lookbackMs = opts.lookbackMs || DEFAULT_LOOKBACK_MS;
  const binFt = opts.binFt || DEFAULT_BIN_FT;
  const minRunFt = opts.minRunFt || DEFAULT_MIN_RUN_FT;
  const minCoverageFrac = opts.minCoverageFrac != null ? opts.minCoverageFrac : DEFAULT_MIN_COVERAGE_FRAC;
  const minSpanFrac = opts.minSpanFrac != null ? opts.minSpanFrac : DEFAULT_MIN_SPAN_FRAC;
  const coldThresholdMs = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? 2 * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );

  const branches = buildLineBranches(trainLines, line);
  if (branches.length === 0) return [];

  const recent = opts.recentPositions || [];
  const sinceTs = now - lookbackMs;
  const fresh = recent.filter((p) => p.ts >= sinceTs);

  if (fresh.length === 0) return [];
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const p of fresh) {
    if (p.ts < minTs) minTs = p.ts;
    if (p.ts > maxTs) maxTs = p.ts;
  }
  if (maxTs - minTs < lookbackMs * minSpanFrac) return [];

  const candidates = [];
  for (let branchIdx = 0; branchIdx < branches.length; branchIdx++) {
    const branch = branches[branchIdx];
    const { points, cumDist, totalFt } = branch;
    if (points.length < 2 || !totalFt) continue;

    const numBins = Math.max(2, Math.ceil(totalFt / binFt));
    const lastSeenPerBin = new Array(numBins).fill(-Infinity);
    const binIdxOfPos = [];
    let onBranch = 0;

    for (const p of fresh) {
      const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
      if (perpDist > MAX_PERP_FT) continue;
      onBranch++;
      const idx = Math.min(numBins - 1, Math.max(0, Math.floor(along / (totalFt / numBins))));
      if (p.ts > lastSeenPerBin[idx]) lastSeenPerBin[idx] = p.ts;
      binIdxOfPos.push(idx);
    }

    const zoneFt = terminalZoneFt(totalFt);
    const zoneBins = Math.ceil(zoneFt / (totalFt / numBins));

    let coveredBins = 0;
    for (const ts of lastSeenPerBin) if (ts > -Infinity) coveredBins++;
    if (coveredBins / numBins < minCoverageFrac) continue;

    const coldBefore = now - coldThresholdMs;
    const cold = lastSeenPerBin.map((ts) => ts < coldBefore);

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

    let lastSeenInRun = -Infinity;
    let positionsInRun = 0;
    for (let i = bestStart; i <= bestEnd; i++) {
      if (lastSeenPerBin[i] > lastSeenInRun) lastSeenInRun = lastSeenPerBin[i];
    }
    for (const idx of binIdxOfPos) {
      if (idx >= bestStart && idx <= bestEnd) positionsInRun++;
    }
    const trainsOutsideRun = Math.max(0, onBranch - positionsInRun);

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
      lastSeenInRunMs: lastSeenInRun > -Infinity ? lastSeenInRun : null,
      coldThresholdMs,
      lookbackMs,
      trainsOutsideRun,
    });
  }

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
  DEFAULT_MIN_COVERAGE_FRAC,
  DEFAULT_MIN_SPAN_FRAC,
  MAX_PERP_FT,
};
