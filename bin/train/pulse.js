#!/usr/bin/env node
// Auto "service pulse" detector — flags suspected service outages from live
// positions + GTFS headways alone, without waiting for a CTA alert.
//
// Runs every 5 min. Calls getAllTrainPositions (which records fresh rows with
// lat/lon into observations), then pulls the last ~20 minutes of positioned
// observations, snaps them onto each branch of each line, looks for long
// contiguous cold-bin runs, and posts a Disruption where the same cold run
// persists for ≥ MIN_CONSECUTIVE_TICKS.
//
// State machine per (line, direction):
//   - pulse_state row tracks the current run's (lo, hi), started_ts,
//     consecutive_ticks, clear_ticks.
//   - Each tick: if a matching candidate exists (≥50% overlap with prior run),
//     increment consecutive_ticks. Otherwise reset the slot to the new candidate.
//   - Post only when consecutive_ticks >= MIN_CONSECUTIVE_TICKS AND not on cooldown.
//   - If no candidate: increment clear_ticks. After CLEAR_TICKS, clear the
//     row and (optionally) the posted cooldown.
//
// Gated by PULSE_DRY_RUN=1 for initial rollout.

require('../../src/shared/env');

const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { detectDeadSegments } = require('../../src/train/pulse');
const { getAllTrainPositions, LINE_COLORS, LINE_NAMES, ALL_LINES } = require('../../src/train/api');
const { loginAlerts, postWithImage } = require('../../src/shared/bluesky');
const { renderDisruption } = require('../../src/map');
const { buildPostText, buildAltText } = require('../../src/shared/disruption');
const { expectedTrainHeadwayMin } = require('../../src/shared/gtfs');
const { getRecentTrainPositions } = require('../../src/shared/observations');
const { acquireCooldown } = require('../../src/shared/state');
const {
  getPulseState, upsertPulseState, clearPulseState, recordDisruption,
} = require('../../src/shared/history');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

const DRY_RUN = process.env.PULSE_DRY_RUN === '1' || process.argv.includes('--dry-run');

const LOOKBACK_MS = 20 * 60 * 1000;
const MIN_CONSECUTIVE_TICKS = 2;   // ~10 min of persistence
const CLEAR_TICKS_TO_RESET = 3;    // ~15 min of clear state before we un-stick
const POST_COOLDOWN_MS = 90 * 60 * 1000;
const MIN_HOUR = 5; // don't fire before 5 AM CT (owl-service edge cases)

function chicagoHourNow(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false, hour: '2-digit',
  }).format(now);
  return parseInt(h, 10);
}

// Overlap of two [loFt, hiFt] intervals as fraction of the smaller.
function overlapFraction(a, b) {
  if (!a || !b) return 0;
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (hi <= lo) return 0;
  const shorter = Math.min(a.hi - a.lo, b.hi - b.lo);
  return shorter > 0 ? (hi - lo) / shorter : 0;
}

async function handleCandidate(line, direction, candidate, agentGetter, now) {
  const prior = getPulseState(line, direction);
  let consecutive = 1;
  let startedTs = now;
  if (prior && prior.run_lo_ft != null) {
    const frac = overlapFraction(
      { lo: prior.run_lo_ft, hi: prior.run_hi_ft },
      { lo: candidate.runLoFt, hi: candidate.runHiFt },
    );
    if (frac >= 0.5) {
      consecutive = (prior.consecutive_ticks || 0) + 1;
      startedTs = prior.started_ts || now;
    }
  }

  const cooldownKey = `train_pulse_${line}_${direction}`;
  upsertPulseState({
    line, direction,
    runLoFt: candidate.runLoFt,
    runHiFt: candidate.runHiFt,
    fromStation: candidate.fromStation.name,
    toStation: candidate.toStation.name,
    startedTs,
    lastSeenTs: now,
    consecutiveTicks: consecutive,
    clearTicks: 0,
    postedCooldownKey: cooldownKey,
  });

  if (consecutive < MIN_CONSECUTIVE_TICKS) {
    console.log(`[${line}/${direction}] candidate ${candidate.fromStation.name}→${candidate.toStation.name} tick ${consecutive}/${MIN_CONSECUTIVE_TICKS}`);
    return;
  }

  const disruption = {
    line,
    suspendedSegment: {
      from: candidate.fromStation.name,
      to: candidate.toStation.name,
    },
    alternative: null,
    reason: null,
    source: 'observed',
    detectedAt: now,
  };

  if (DRY_RUN) {
    let image = null;
    try {
      image = await renderDisruption({
        disruption, trainLines, lineColors: LINE_COLORS, trains: [], stations: trainStations,
      });
    } catch (e) {
      console.warn(`renderDisruption failed: ${e.message}`);
    }
    const text = buildPostText(disruption);
    const alt = buildAltText(disruption);
    const stub = image ? writeDryRunAsset(image, `pulse-${line}-${direction}-${now}.jpg`) : '(render failed)';
    console.log(`--- DRY RUN pulse ${line}/${direction} ---\n${text}\n\nAlt: ${alt}\nImage: ${stub}`);
    recordDisruption({
      kind: 'train', line, direction,
      fromStation: candidate.fromStation.name,
      toStation: candidate.toStation.name,
      source: 'observed', posted: false, postUri: null,
    });
    return;
  }

  if (!acquireCooldown(cooldownKey, now, POST_COOLDOWN_MS)) {
    console.log(`[${line}/${direction}] on cooldown, skipping`);
    recordDisruption({
      kind: 'train', line, direction,
      fromStation: candidate.fromStation.name,
      toStation: candidate.toStation.name,
      source: 'observed', posted: false, postUri: null,
    });
    return;
  }

  let image;
  try {
    image = await renderDisruption({
      disruption, trainLines, lineColors: LINE_COLORS, trains: [], stations: trainStations,
    });
  } catch (e) {
    console.error(`renderDisruption failed for ${line}: ${e.stack || e.message}`);
    return;
  }
  const text = buildPostText(disruption);
  const alt = buildAltText(disruption);

  const agent = await agentGetter();
  const result = await postWithImage(agent, text, image, alt);
  console.log(`Posted pulse ${line}/${direction}: ${result.url}`);
  recordDisruption({
    kind: 'train', line, direction,
    fromStation: candidate.fromStation.name,
    toStation: candidate.toStation.name,
    source: 'observed', posted: true, postUri: result.uri,
  });
}

function handleClear(line, direction, now) {
  const prior = getPulseState(line, direction);
  if (!prior) return;
  const clearTicks = (prior.clear_ticks || 0) + 1;
  if (clearTicks >= CLEAR_TICKS_TO_RESET) {
    console.log(`[${line}/${direction}] cleared after ${clearTicks} clean ticks`);
    clearPulseState(line, direction);
    return;
  }
  upsertPulseState({
    ...priorToUpsertArgs(prior),
    clearTicks,
    lastSeenTs: now,
  });
}

function priorToUpsertArgs(prior) {
  return {
    line: prior.line,
    direction: prior.direction,
    runLoFt: prior.run_lo_ft,
    runHiFt: prior.run_hi_ft,
    fromStation: prior.from_station,
    toStation: prior.to_station,
    startedTs: prior.started_ts,
    lastSeenTs: prior.last_seen_ts,
    consecutiveTicks: prior.consecutive_ticks,
    clearTicks: prior.clear_ticks,
    postedCooldownKey: prior.posted_cooldown_key,
  };
}

async function main() {
  setup();
  const now = Date.now();

  if (chicagoHourNow(new Date(now)) < MIN_HOUR) {
    console.log(`Skipping pulse before ${MIN_HOUR} AM CT`);
    return;
  }

  // Prime observations with a fresh fetch so the recent-positions window has
  // at least one new snapshot.
  try {
    await getAllTrainPositions();
  } catch (e) {
    console.warn(`getAllTrainPositions failed: ${e.message}`);
  }

  const sinceTs = now - LOOKBACK_MS;
  const allRecent = getRecentTrainPositions(sinceTs);

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  for (const line of ALL_LINES) {
    const recent = allRecent.filter((r) => r.line === line);
    if (recent.length === 0) {
      // No positioned observations means we have no signal — don't clear
      // an existing state based on missing data, just skip.
      continue;
    }

    const headwayMin = safeHeadway(line);

    let candidates;
    try {
      candidates = detectDeadSegments({
        line,
        observations: [],
        recentPositions: recent.map((r) => ({ ts: r.ts, lat: r.lat, lon: r.lon, rn: r.rn, trDr: r.trDr })),
        trainLines,
        stations: trainStations,
        headwayMin,
        now,
        opts: { lookbackMs: LOOKBACK_MS },
      });
    } catch (e) {
      console.error(`pulse detect failed for ${line}: ${e.stack || e.message}`);
      continue;
    }

    if (candidates.length === 0) {
      // No candidate this tick: mark any active state as clearing, potentially
      // reset after CLEAR_TICKS_TO_RESET clean ticks.
      // Iterate over any existing pulse_state rows for this line.
      const { getDb } = require('../../src/shared/history');
      const rows = getDb().prepare('SELECT * FROM pulse_state WHERE line = ?').all(line);
      for (const row of rows) handleClear(line, row.direction, now);
      continue;
    }

    // Best candidate per (line, direction) — detector already sorts worst-first,
    // but it may return one per branch; we handle them all.
    const seenDirs = new Set();
    for (const c of candidates) {
      if (seenDirs.has(c.direction)) continue;
      seenDirs.add(c.direction);
      try {
        await handleCandidate(line, c.direction, c, agentGetter, now);
      } catch (e) {
        console.error(`handleCandidate failed for ${line}/${c.direction}: ${e.stack || e.message}`);
      }
    }

    // Clear any stale pulse_state rows that no longer have a matching candidate
    // for this line.
    const { getDb } = require('../../src/shared/history');
    const rows = getDb().prepare('SELECT * FROM pulse_state WHERE line = ?').all(line);
    for (const row of rows) {
      if (!seenDirs.has(row.direction)) handleClear(line, row.direction, now);
    }
  }
}

// Destination lookup for headway is per-direction; for the pulse we want a
// coarse line-wide number as a scaling factor for the cold-bin threshold.
// Falls back to null (detector uses its 15-min floor).
function safeHeadway(line) {
  try {
    // Passing null destination lets loop lines resolve line-wide; bi-directional
    // lines will return null, which is fine — the detector uses its default.
    return expectedTrainHeadwayMin(line, null);
  } catch (e) {
    return null;
  }
}

runBin(main);
