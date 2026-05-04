// Detects dead segments on a rail line: stretches where no train has appeared
// recently enough that something is probably wrong. Pure function — no DB
// writes; persistence/cooldown gating lives in the bin script.
//
// Each branch is binned by along-track distance; a bin is "cold" when no
// train has projected into it within max(2.5× headway, 15 min) — the
// multiplier lets the threshold open up during sparse off-peak service while
// the floor keeps peak detection from getting jumpy. Loop lines
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

const {
  buildLineBranches,
  snapToLineWithPerp,
  inLoopTrunk,
  LOOP_TRUNK_LINES,
} = require('./speedmap');
const { lineLabel } = require('./api');
const { terminalZoneFt } = require('../shared/geo');

const MAX_PERP_FT = 1500; // reject projections from off-branch trains
const DEFAULT_LOOKBACK_MS = 20 * 60 * 1000;
const DEFAULT_BIN_FT = 1320; // 0.25 mi
const DEFAULT_MIN_RUN_FT_LONG = 10560; // 2 mi — sparse outer-branch fallback
const DEFAULT_MIN_COLD_MS = 15 * 60 * 1000;
// Multipliers on scheduled headway. The headway-driven threshold scales the
// detector with service density: peak weekday (~4 min) clamps at the 15-min
// floor (3.75× headway), Sunday midday (~10 min) opens to 25 min (2.5× ⇒
// would-have-prevented the 2026-05-03 Montrose→Belmont 16-min false alarm),
// late-night sparse service (~15 min) opens to 37.5 min.
const COLD_HEADWAY_MULT = 2.5;
const COLD_HEADWAY_MULT_STRICT = 3.5;
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
    headwayMin != null ? COLD_HEADWAY_MULT * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );
  const coldThresholdMsStrict = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? COLD_HEADWAY_MULT_STRICT * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
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
    // sees only its half of the traffic. Exception: bins on the Loop trunk
    // (Lake/Wabash/Van Buren/Wells) accept either direction, because
    // TrainTracker flips trDr at the Loop apex mid-circuit and a Brown
    // inbound train tagged "outbound" while still on the south Loop would
    // otherwise leave inbound bins falsely cold.
    const branchObs = fresh;

    const numBins = Math.max(2, Math.ceil(totalFt / binFt));
    const binLengthFt = totalFt / numBins;
    const loopTrunkBin = new Array(numBins).fill(false);
    const useLoopTrunkOverride = trDrFilter && LOOP_TRUNK_LINES.has(line);
    if (useLoopTrunkOverride) {
      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const lat = pt.lat != null ? pt.lat : pt[0];
        const lon = pt.lon != null ? pt.lon : pt[1];
        if (!inLoopTrunk(lat, lon)) continue;
        const idx = Math.min(numBins - 1, Math.max(0, Math.floor(cumDist[i] / binLengthFt)));
        loopTrunkBin[idx] = true;
      }
    }
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
      if (trDrFilter && p.trDr !== trDrFilter && !(useLoopTrunkOverride && loopTrunkBin[idx])) {
        continue;
      }
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
        `[pulse] line=${lineLabel(line)} branch=${branchIdx} eligible scan range only ${numBins - 2 * zoneBins} bins — short branch may misfire`,
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

    // Turnaround-tail veto: on round-trip lines (Brown/Orange/Pink/Purple)
    // each branch is filtered by trDr, but Train Tracker flips trDr at the
    // terminal as trains turn around. The result is that the segment between
    // the second-to-last station and the terminal sees only brief 1–2 obs
    // dir-matched windows per inbound train (everything else gets re-tagged
    // outbound). At off-peak headways that's enough random clustering to
    // produce 30+ min gaps in the dir-matched feed even though service is
    // running normally. The geometric terminal-zone clip (terminalZoneFt =
    // 1500 ft) doesn't help: South Boulevard→Howard on Purple is 0.7 mi, so
    // the run sits just outside the zone but still names Howard as `to`.
    // Reject candidates whose named endpoint IS the branch's first or last
    // station when a trDrFilter is in play — those are tail artifacts, not
    // service gaps.
    if (trDrFilter && stationsOnBranch.length >= 2) {
      const branchHead = stationsOnBranch[0].station.name;
      const branchTail = stationsOnBranch[stationsOnBranch.length - 1].station.name;
      if (
        fromStation.station.name === branchHead ||
        toStation.station.name === branchHead ||
        fromStation.station.name === branchTail ||
        toStation.station.name === branchTail
      ) {
        continue;
      }
    }

    // Terminal-adjacency veto: cold runs sitting at the corridor's terminal-
    // most station with `coldMs` barely clearing the threshold are usually a
    // single missed turnaround on a sparse line, not a real outage. Require a
    // 1.2× margin over threshold for terminal-adjacent runs unless the run is
    // long (passLong-ish) or a dispatch-continuity check will catch it.
    let terminalAdjacent = false;
    if (stationsOnBranch.length >= 2) {
      const corridorLoFt = corridorLo * binLengthFt;
      const corridorHiFt = corridorHi * binLengthFt;
      const corridorTerminalDistFt = 2640; // 0.5 mi
      const inCorridor = stationsOnBranch.filter(
        (s) => s.trackDist >= corridorLoFt && s.trackDist <= corridorHiFt,
      );
      if (inCorridor.length >= 2) {
        const corridorWest = inCorridor[0];
        const corridorEast = inCorridor[inCorridor.length - 1];
        const fromIsTerminalAdjacent =
          Math.abs(fromStation.trackDist - corridorWest.trackDist) <= corridorTerminalDistFt ||
          Math.abs(fromStation.trackDist - corridorEast.trackDist) <= corridorTerminalDistFt;
        const toIsTerminalAdjacent =
          Math.abs(toStation.trackDist - corridorWest.trackDist) <= corridorTerminalDistFt ||
          Math.abs(toStation.trackDist - corridorEast.trackDist) <= corridorTerminalDistFt;
        terminalAdjacent = fromIsTerminalAdjacent || toIsTerminalAdjacent;
      }
    }

    // Ramp-up veto: the day's first direction-matching train may simply not
    // have reached this stretch yet. Brown 06:10 FPs are the canonical case —
    // outbound service started at 05:34, but vehicle 401 was still climbing
    // toward Western and hadn't entered Francisco↔Irving Park. The 20 min
    // lookback can't tell that apart from a real outage; a 2 h lookback
    // can. If no direction-matching observation has reached the cold run's
    // near edge in the past 2 h, treat it as not-yet-served, not cold.
    if (opts.longLookbackPositions && opts.longLookbackPositions.length > 0 && trDrFilter) {
      let maxAlongDirMatch = -Infinity;
      for (const p of opts.longLookbackPositions) {
        if (p.trDr !== trDrFilter) continue;
        const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
        if (perpDist > MAX_PERP_FT) continue;
        if (along > maxAlongDirMatch) maxAlongDirMatch = along;
      }
      if (maxAlongDirMatch < runLoFt) {
        console.log(
          `[${lineLabel(line)}/${directionKeyFor(branches, branchIdx, directionHint)}] ramp-up suppressed: no direction-${trDrFilter} obs reached ${(runLoFt / 5280).toFixed(1)}mi in past 2h (max=${(maxAlongDirMatch / 5280).toFixed(1)}mi)`,
        );
        continue;
      }
    }

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

    // Direction-of-travel destination for the trDr-matched feed, derived
    // empirically from per-run net displacement. Lets the title say "trains
    // to Howard not seen" on a Sunday Purple shuttle (where inbound trains
    // terminate at Howard) instead of the static "trains to the Loop" —
    // which is only correct on weekday peak when Express service runs
    // through. Earlier heuristic compared along-extremes to the branch
    // midpoint, which silently picked the wrong end whenever trDr-matched
    // trains traversed (or nearly traversed) the full corridor — both
    // extremes were equidistant from the midpoint and the tiebreak defaulted
    // to the high-cumDist station, producing reversed direction text on
    // Pink/Purple branch-0-outbound posts.
    let directionDestinationName = null;
    if (trDrFilter && stationsOnBranch.length >= 2) {
      const runFirst = new Map();
      const runLast = new Map();
      for (const p of branchObs) {
        if (p.trDr !== trDrFilter) continue;
        if (p.rn == null) continue;
        const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, points, cumDist);
        if (perpDist > MAX_PERP_FT) continue;
        const f = runFirst.get(p.rn);
        if (!f || p.ts < f.ts) runFirst.set(p.rn, { ts: p.ts, along });
        const l = runLast.get(p.rn);
        if (!l || p.ts > l.ts) runLast.set(p.rn, { ts: p.ts, along });
      }
      let netDisplacement = 0;
      for (const [rn, first] of runFirst) {
        const last = runLast.get(rn);
        if (!last || last.ts === first.ts) continue;
        netDisplacement += last.along - first.along;
      }
      if (netDisplacement !== 0) {
        const towardHi = netDisplacement > 0;
        const corridorLoFt = corridorLo * (totalFt / numBins);
        const corridorHiFt = corridorHi * (totalFt / numBins);
        const inCorridor = stationsOnBranch.filter(
          (s) => s.trackDist >= corridorLoFt && s.trackDist <= corridorHiFt,
        );
        if (inCorridor.length > 0) {
          const dest = towardHi ? inCorridor[inCorridor.length - 1] : inCorridor[0];
          // If the picked terminus station sits inside the Loop trunk on a
          // Loop-circling line (Brown/Orange/Pink/Purple), leave the empirical
          // name unset so terminusFor() falls back to the "the Loop" string.
          // Naming a specific Loop station ("Harold Washington Library",
          // "Quincy") misleads readers — these lines circle through the Loop
          // rather than terminating at any one stop on it.
          const stLat = dest.station.lat;
          const stLon = dest.station.lon;
          const inTrunk =
            LOOP_TRUNK_LINES.has(line) &&
            stLat != null &&
            stLon != null &&
            inLoopTrunk(stLat, stLon);
          if (!inTrunk) directionDestinationName = dest.station.name;
        }
      }
    }

    // Composite admit gate: any one of the three paths is sufficient. Minor
    // veto already happened upstream via cold-threshold + terminal exclusion.
    // Every path also requires coldMs >= coldThresholdMs — without this gate,
    // passLong/passMulti would admit a 2-mi cold run at coldMs == headway
    // (1× scheduled), which is well within natural bunching variance and
    // produced FPs on sparse-service lines (Sunday Green @ 20-min headway,
    // Pulaski→Kedzie went cold for ~20 min and tripped the alert despite
    // service running normally).
    const passLong = runLengthFt >= minRunFtLong && coldMs >= coldThresholdMs;
    const passMulti = coldStations >= 2 && coldMs >= coldThresholdMs;
    const passSolo =
      coldStations >= 1 &&
      expectedTrains != null &&
      expectedTrains >= SOLO_EXPECTED_TRAINS &&
      coldMs >= coldThresholdMsStrict;
    if (!(passLong || passMulti || passSolo)) continue;

    // Terminal-adjacency margin: terminal-adjacent runs need 1.2× threshold
    // unless they're already long (passLong covers genuine sustained outages
    // at the line's edges).
    if (terminalAdjacent && !passLong && coldMs < 1.2 * coldThresholdMs) {
      continue;
    }

    // Dispatch-continuity veto: if GTFS says a scheduled trip start should
    // have happened in the lookback window AND coldMs is within 1.5× threshold
    // AND it's not a long sustained outage, treat as a between-dispatch gap.
    if (
      opts.expectedDispatchesInWindow != null &&
      opts.expectedDispatchesInWindow >= 1 &&
      !passLong &&
      coldMs < 1.5 * coldThresholdMs
    ) {
      continue;
    }

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
      headwayMin: headwayMin != null ? headwayMin : null,
      directionDestinationName,
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
