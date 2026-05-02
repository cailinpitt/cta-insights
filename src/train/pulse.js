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
    // Per-train trajectories, used downstream to detect trains that crossed
    // the cold run between snapshots — at ~3-5 min observer cadence, trains
    // moving at typical speeds traverse a 0.25mi bin in <60s and frequently
    // skip over a 1mi run between adjacent obs without ever being recorded
    // inside it. Without this check, fast traversals look identical to true
    // outages.
    const trajByRun = new Map();
    // Track unique runs seen anywhere on the branch + which of those touched
    // a bin inside the cold run, so trainsOutsideRun counts trains, not raw
    // observation rows (with ~15s observation cadence, each train contributes
    // ~80 rows in a 20 min lookback — counting rows produced absurd numbers
    // like "171 trains active elsewhere on the line" for a 5-train line).
    const runsOnBranch = new Set();
    const runsInRunBins = [];
    const binIdxOfRun = [];

    for (const p of branchObs) {
      const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
      if (perpDist > MAX_PERP_FT) continue;
      const idx = Math.min(numBins - 1, Math.max(0, Math.floor(along / (totalFt / numBins))));
      if (p.ts > lastSeenPerBin[idx]) lastSeenPerBin[idx] = p.ts;
      binIdxOfPos.push(idx);
      if (p.rn) {
        runsOnBranch.add(p.rn);
        binIdxOfRun.push({ rn: p.rn, idx });
        let traj = trajByRun.get(p.rn);
        if (!traj) {
          traj = [];
          trajByRun.set(p.rn, traj);
        }
        traj.push({ ts: p.ts, along });
      }
    }

    const zoneFt = terminalZoneFt(totalFt);
    const zoneBins = Math.ceil(zoneFt / (totalFt / numBins));
    if (numBins - 2 * zoneBins < 4) {
      console.warn(
        `[pulse] line=${line} branch=${branchIdx} eligible scan range only ${numBins - 2 * zoneBins} bins — short branch may misfire`,
      );
    }

    // Service-corridor clip: when caller passes a corridorBbox derived from
    // the last several hours of train observations, project its corners onto
    // the branch and treat any bin outside that trackDist range as "outside
    // active service" rather than cold. Catches Purple weekend (Linden ↔
    // Howard only) and any other line where the polyline includes track that
    // isn't actually being used right now.
    let corridorLo = 0;
    let corridorHi = numBins;
    if (opts.corridorBbox) {
      const c = opts.corridorBbox;
      const corners = [
        { lat: c.minLat, lon: c.minLon },
        { lat: c.minLat, lon: c.maxLon },
        { lat: c.maxLat, lon: c.minLon },
        { lat: c.maxLat, lon: c.maxLon },
      ];
      let minAlong = Infinity;
      let maxAlong = -Infinity;
      for (const corner of corners) {
        const { cumDist: along } = snapToLineWithPerp(corner.lat, corner.lon, points, cumDist);
        if (along < minAlong) minAlong = along;
        if (along > maxAlong) maxAlong = along;
      }
      if (Number.isFinite(minAlong) && Number.isFinite(maxAlong) && maxAlong > minAlong) {
        const binLengthFt = totalFt / numBins;
        corridorLo = Math.max(0, Math.floor(minAlong / binLengthFt));
        corridorHi = Math.min(numBins, Math.ceil(maxAlong / binLengthFt));
      }
    }

    let coveredBins = 0;
    let corridorBinCount = 0;
    for (let i = 0; i < numBins; i++) {
      if (i < corridorLo || i >= corridorHi) continue;
      corridorBinCount++;
      if (lastSeenPerBin[i] > -Infinity) coveredBins++;
    }
    if (corridorBinCount > 0 && coveredBins / corridorBinCount < minCoverageFrac) continue;
    allBranchesSparse = false;

    const coldBefore = now - coldThresholdMs;
    const cold = lastSeenPerBin.map((ts) => ts < coldBefore);

    let bestStart = -1;
    let bestEnd = -1;
    let curStart = -1;
    const scanStart = Math.max(zoneBins, corridorLo);
    const scanEnd = Math.min(numBins - zoneBins, corridorHi);
    for (let i = scanStart; i < scanEnd; i++) {
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
    // A run that only resolves to one station (or two with the same name)
    // doesn't yield a renderable suspended-segment polyline downstream and
    // can't be described as "X to Y" in a post. Skip rather than emit a
    // degenerate "Halsted → Halsted" candidate.
    if (fromStation.station.name === toStation.station.name) continue;

    // Aliasing veto: did any train's consecutive observations bracket the
    // cold run? If so, the train physically crossed it between snapshots —
    // not a true outage, just a fast traversal.
    let crossed = false;
    for (const traj of trajByRun.values()) {
      if (traj.length < 2) continue;
      traj.sort((a, b) => a.ts - b.ts);
      for (let i = 1; i < traj.length; i++) {
        const a = traj[i - 1].along;
        const b = traj[i].along;
        if ((a < runLoFt && b > runHiFt) || (a > runHiFt && b < runLoFt)) {
          crossed = true;
          break;
        }
      }
      if (crossed) break;
    }
    if (crossed) continue;

    let lastSeenInRun = -Infinity;
    for (let i = bestStart; i <= bestEnd; i++) {
      if (lastSeenPerBin[i] > lastSeenInRun) lastSeenInRun = lastSeenPerBin[i];
    }
    const runsInRun = new Set();
    for (const { rn, idx } of binIdxOfRun) {
      if (idx >= bestStart && idx <= bestEnd) runsInRun.add(rn);
    }
    let trainsOutsideRun = 0;
    for (const rn of runsOnBranch) if (!runsInRun.has(rn)) trainsOutsideRun++;

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
      directionHint: directionHint || null,
      runLoFt,
      runHiFt,
      runLengthFt,
      fromStation: fromStation.station,
      toStation: toStation.station,
      coldBins: bestEnd - bestStart + 1,
      totalBins: numBins,
      observedTrainsInWindow: runsOnBranch.size,
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
