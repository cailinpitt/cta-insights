// Detects dead segments on a rail line: stretches where no train has appeared
// recently enough that something is probably wrong. Pure function — no DB
// writes; persistence/cooldown gating lives in the bin script.
//
// Each branch is binned by along-track distance; a bin is "cold" when no
// train has projected into it within max(2× headway, 15 min). Loop lines
// (Brown/Orange/Pink/Purple) split into outbound/inbound branches sharing
// geometry but filtered by Train Tracker direction code, so single-direction
// outages don't get masked by trains running the other way.
//
// A candidate is admitted via any of three paths (composite gate):
//   passLong  — run length ≥ 2 mi (sparse outer-branch fallback)
//   passMulti — ≥ 2 stations completely inside the cold run
//   passSolo  — ≥ 1 station + ≥3 expected-but-missed trains + ≥3× headway
//               cold time (excludes held-train false positives)
// Returns { skipped, candidates } so the bin can distinguish "no signal"
// (don't touch existing pulse_state) from "all clear" (advance clear ticks).

const { buildLineBranches, snapToLineWithPerp } = require('./speedmap');
const { terminalZoneFt } = require('../shared/geo');

const MAX_PERP_FT = 1500; // reject projections from off-branch trains
const DEFAULT_LOOKBACK_MS = 20 * 60 * 1000;
const DEFAULT_BIN_FT = 1320; // 0.25 mi
const DEFAULT_MIN_RUN_FT_LONG = 10560; // 2 mi — sparse outer-branch fallback
const DEFAULT_MIN_COLD_MS = 15 * 60 * 1000;
const DEFAULT_MIN_COVERAGE_FRAC = 0.5;
const DEFAULT_MIN_SPAN_FRAC = 0.5;
// Number of expected-but-missed trains required for the 1-station passSolo
// admit path. Three trains in a row going missing isn't normal variance.
const SOLO_EXPECTED_TRAINS = 3;

function detectDeadSegments({ line, trainLines, stations, headwayMin, now, opts = {} }) {
  const lookbackMs = opts.lookbackMs || DEFAULT_LOOKBACK_MS;
  const binFt = opts.binFt || DEFAULT_BIN_FT;
  const minRunFtLong = opts.minRunFt || DEFAULT_MIN_RUN_FT_LONG;
  const minCoverageFrac =
    opts.minCoverageFrac != null ? opts.minCoverageFrac : DEFAULT_MIN_COVERAGE_FRAC;
  const minSpanFrac = opts.minSpanFrac != null ? opts.minSpanFrac : DEFAULT_MIN_SPAN_FRAC;
  const coldThresholdMs = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? 2 * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );
  const coldThresholdMsStrict = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? 3 * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );

  const branches = buildLineBranches(trainLines, line);
  if (branches.length === 0) return { skipped: 'no-branches', candidates: [] };

  const recent = opts.recentPositions || [];
  const sinceTs = now - lookbackMs;
  const fresh = recent.filter((p) => p.ts >= sinceTs);

  if (fresh.length === 0) return { skipped: 'noobs', candidates: [] };
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const p of fresh) {
    if (p.ts < minTs) minTs = p.ts;
    if (p.ts > maxTs) maxTs = p.ts;
  }
  if (maxTs - minTs < lookbackMs * minSpanFrac) {
    return { skipped: 'sparse-span', candidates: [] };
  }

  const candidates = [];
  let allBranchesSparse = true;
  for (let branchIdx = 0; branchIdx < branches.length; branchIdx++) {
    const branch = branches[branchIdx];
    const { points, cumDist, totalFt, trDrFilter, directionHint } = branch;
    if (points.length < 2 || !totalFt) continue;

    // Round-trip lines split into outbound/inbound branches sharing geometry
    // — filter observations by Train Tracker direction code so each branch
    // sees only its half of the traffic.
    const branchObs = trDrFilter ? fresh.filter((p) => p.trDr === trDrFilter) : fresh;

    const numBins = Math.max(2, Math.ceil(totalFt / binFt));
    const lastSeenPerBin = new Array(numBins).fill(-Infinity);
    const binIdxOfPos = [];
    let onBranch = 0;

    for (const p of branchObs) {
      const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
      if (perpDist > MAX_PERP_FT) continue;
      onBranch++;
      const idx = Math.min(numBins - 1, Math.max(0, Math.floor(along / (totalFt / numBins))));
      if (p.ts > lastSeenPerBin[idx]) lastSeenPerBin[idx] = p.ts;
      binIdxOfPos.push(idx);
    }

    const zoneFt = terminalZoneFt(totalFt);
    const zoneBins = Math.ceil(zoneFt / (totalFt / numBins));
    if (numBins - 2 * zoneBins < 4) {
      console.warn(
        `[pulse] line=${line} branch=${branchIdx} eligible scan range only ${numBins - 2 * zoneBins} bins — short branch may misfire`,
      );
    }

    let coveredBins = 0;
    for (const ts of lastSeenPerBin) if (ts > -Infinity) coveredBins++;
    if (coveredBins / numBins < minCoverageFrac) continue;
    allBranchesSparse = false;

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

    const stationsOnBranch = stationsAlongBranch(stations, line, points, cumDist);
    // Bug 19: clip from/to to stations strictly inside the cold run rather
    // than reaching out to the nearest station, which used to push the named
    // endpoints past the terminal-zone clip.
    const stationsInRun = stationsOnBranch.filter(
      (s) => s.trackDist >= runLoFt && s.trackDist <= runHiFt,
    );
    if (stationsInRun.length < 1) continue;
    const fromStation = stationsInRun[0];
    const toStation = stationsInRun[stationsInRun.length - 1];
    if (fromStation.station.name === toStation.station.name && stationsInRun.length === 1) {
      // 1-station passSolo path can still anchor on a single station; mark it.
    } else if (fromStation.station.name === toStation.station.name) {
      continue;
    }

    let lastSeenInRun = -Infinity;
    let positionsInRun = 0;
    for (let i = bestStart; i <= bestEnd; i++) {
      if (lastSeenPerBin[i] > lastSeenInRun) lastSeenInRun = lastSeenPerBin[i];
    }
    for (const idx of binIdxOfPos) {
      if (idx >= bestStart && idx <= bestEnd) positionsInRun++;
    }
    const trainsOutsideRun = Math.max(0, onBranch - positionsInRun);

    const lastSeenInRunMs = lastSeenInRun > -Infinity ? lastSeenInRun : null;
    const coldMs = lastSeenInRunMs ? now - lastSeenInRunMs : lookbackMs;
    const expectedTrains = headwayMin ? Math.floor(coldMs / 60_000 / headwayMin) : null;
    const coldStations = stationsInRun.length;
    const coldStationNames = stationsInRun.map((s) => s.station.name);

    // Composite admit gate: any one of the three paths is sufficient. Minor
    // veto already happened upstream via cold-threshold + terminal exclusion.
    const passLong = runLengthFt >= minRunFtLong;
    const passMulti = coldStations >= 2;
    const passSolo =
      coldStations >= 1 &&
      expectedTrains != null &&
      expectedTrains >= SOLO_EXPECTED_TRAINS &&
      coldMs >= coldThresholdMsStrict;
    if (!(passLong || passMulti || passSolo)) continue;

    candidates.push({
      line,
      direction: directionKeyFor(branches, branchIdx, directionHint),
      runLoFt,
      runHiFt,
      runLengthFt,
      fromStation: fromStation.station,
      toStation: toStation.station,
      coldBins: bestEnd - bestStart + 1,
      totalBins: numBins,
      observedTrainsInWindow: onBranch,
      lastSeenInRunMs,
      coldThresholdMs,
      lookbackMs,
      trainsOutsideRun,
      coldStations,
      coldStationNames,
      expectedTrains,
    });
  }

  if (allBranchesSparse && candidates.length === 0 && branches.length > 0) {
    return { skipped: 'sparse-coverage', candidates: [] };
  }
  candidates.sort((a, b) => {
    // Prefer candidates with more cold stations, breaking ties by length.
    if (b.coldStations !== a.coldStations) return b.coldStations - a.coldStations;
    return b.runLengthFt - a.runLengthFt;
  });
  return { skipped: null, candidates };
}

// Direction key used as the (line, direction) PK in pulse_state. Stable
// across reorderings of trainLines.json: derives from directionHint
// (outbound/inbound) for round-trip splits, or from a length+terminal
// signature for multi-branch bidirectional lines (Blue, Green).
function directionKeyFor(branches, branchIdx, directionHint) {
  if (branches.length === 1) return 'all';
  if (directionHint) return `branch-${branchIdx}-${directionHint}`;
  const branch = branches[branchIdx];
  if (!branch?.points?.length) return `branch-${branchIdx}`;
  const lastPt = branch.points[branch.points.length - 1];
  const lat = Array.isArray(lastPt) ? lastPt[0] : lastPt.lat;
  const lon = Array.isArray(lastPt) ? lastPt[1] : lastPt.lon;
  const latStr = String(Math.round(lat * 1000));
  const lonStr = String(Math.round(lon * 1000));
  const lenK = Math.round(branch.totalFt / 1000);
  return `branch-len${lenK}-${latStr}-${lonStr}`;
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
  stationsAlongBranch,
  nearestStationAtOrBefore,
  nearestStationAtOrAfter,
  directionKeyFor,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_BIN_FT,
  DEFAULT_MIN_RUN_FT_LONG,
  DEFAULT_MIN_COVERAGE_FRAC,
  DEFAULT_MIN_SPAN_FRAC,
  SOLO_EXPECTED_TRAINS,
  MAX_PERP_FT,
};
