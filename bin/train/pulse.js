#!/usr/bin/env node
// Posts when a candidate dead segment overlaps the previous tick's run by
// ≥50% for MIN_CONSECUTIVE_TICKS. Clears state after CLEAR_TICKS_TO_RESET
// clean ticks. Per-(line, direction) state lives in pulse_state.
//
// Cold-start guards (`MIN_DISTINCT_TS`, the detector's coverage/span gates)
// stop a freshly-bootstrapped observations table from looking like a
// system-wide outage. Set PULSE_DRY_RUN=1 to exercise the full detection
// path without posting — recommended after any deploy that touches this code.

require('../../src/shared/env');

const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { detectDeadSegments } = require('../../src/train/pulse');
const { getAllTrainPositions, LINE_COLORS, LINE_NAMES, ALL_LINES } = require('../../src/train/api');
const { loginAlerts, postWithImage, postText, resolveReplyRef } = require('../../src/shared/bluesky');
const { renderDisruption } = require('../../src/map');
const { buildPostText, buildAltText, buildClearPostText } = require('../../src/shared/disruption');
const { expectedTrainHeadwayMin } = require('../../src/shared/gtfs');
const { getRecentTrainPositions } = require('../../src/shared/observations');
const { acquireCooldown } = require('../../src/shared/state');
const {
  getPulseState, upsertPulseState, clearPulseState, recordDisruption,
  getRecentPulsePost, hasObservedClearSince, ctaAlertPostedSince, getDb,
} = require('../../src/shared/history');
const { clearCooldown } = require('../../src/shared/state');
const { LINE_TO_RAIL_ROUTE } = require('../../src/shared/ctaAlerts');
const { rolloffOldObservations } = require('../../src/shared/observations');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

const DRY_RUN = process.env.PULSE_DRY_RUN === '1' || process.argv.includes('--dry-run');

const LOOKBACK_MS = 20 * 60 * 1000;
const MIN_CONSECUTIVE_TICKS = 2;
const CLEAR_TICKS_TO_RESET = 3;
const POST_COOLDOWN_MS = 90 * 60 * 1000;
const MIN_HOUR = 5; // owl service edge cases — wait until daytime patterns kick in
const MIN_DISTINCT_TS = 3;

function chicagoHourNow(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false, hour: '2-digit',
  }).format(now);
  return parseInt(h, 10);
}

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

  const segmentTag = `${Math.round(candidate.runLoFt)}_${Math.round(candidate.runHiFt)}`;
  const cooldownKey = `train_pulse_${line}_${direction}_${segmentTag}`;
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
    evidence: {
      runLengthMi: Math.round((candidate.runLengthFt / 5280) * 10) / 10,
      minutesSinceLastTrain: candidate.lastSeenInRunMs != null
        ? Math.round((now - candidate.lastSeenInRunMs) / 60000)
        : null,
      lookbackMin: Math.round(candidate.lookbackMs / 60000),
      coldThresholdMin: Math.round(candidate.coldThresholdMs / 60000),
      trainsOutsideRun: candidate.trainsOutsideRun,
    },
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

  clearPulseState(line, direction);

  recordDisruption({
    kind: 'train', line, direction,
    fromStation: candidate.fromStation.name,
    toStation: candidate.toStation.name,
    source: 'observed', posted: false, postUri: null,
  });

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
  const replyRef = await findOpenAlertReplyRef(agent, line);
  const result = await postWithImage(agent, text, image, alt, replyRef);
  console.log(`Posted pulse ${line}/${direction}: ${result.url}`);
  recordDisruption({
    kind: 'train', line, direction,
    fromStation: candidate.fromStation.name,
    toStation: candidate.toStation.name,
    source: 'observed', posted: true, postUri: result.uri,
  });
}

async function handleClear(line, direction, agentGetter, now) {
  const prior = getPulseState(line, direction);
  if (!prior) return;
  const clearTicks = (prior.clear_ticks || 0) + 1;
  if (clearTicks >= CLEAR_TICKS_TO_RESET) {
    console.log(`[${line}/${direction}] cleared after ${clearTicks} clean ticks`);
    await postClearReply(line, direction, prior, agentGetter);
    if (prior.posted_cooldown_key) clearCooldown(prior.posted_cooldown_key);
    clearPulseState(line, direction);
    return;
  }
  upsertPulseState({
    ...priorToUpsertArgs(prior),
    clearTicks,
    lastSeenTs: now,
  });
}

// Post a green-checkmark reply under the original pulse when the bot's
// detector says trains are running through the previously cold stretch
// again. We post even when a CTA alert has been threaded under the pulse —
// the bot's "trains are moving" signal and CTA's "we've cleared the alert"
// signal are independent and both belong in the thread.
async function postClearReply(line, direction, prior, agentGetter) {
  const recentPulse = getRecentPulsePost({ kind: 'train', line, direction, withinMs: 24 * 60 * 60 * 1000 });
  if (!recentPulse) return;

  // Idempotency: if a clear reply already exists for this pulse (e.g. previous
  // run posted but crashed before clearPulseState), skip rather than duplicate.
  if (hasObservedClearSince({ kind: 'train', line, direction, sinceTs: recentPulse.ts })) {
    console.log(`[${line}/${direction}] clear reply already posted for this pulse — skipping`);
    return;
  }

  const ctaCode = LINE_TO_RAIL_ROUTE[line];
  const ctaAlertOpen = !!(ctaCode && ctaAlertPostedSince({ kind: 'train', ctaRouteCode: ctaCode, sinceTs: recentPulse.ts }));

  const fromStation = prior.from_station || recentPulse.from_station;
  const toStation = prior.to_station || recentPulse.to_station;
  if (!fromStation || !toStation) return;

  const disruption = { line, suspendedSegment: { from: fromStation, to: toStation } };
  const text = buildClearPostText(disruption, { ctaAlertOpen });

  if (DRY_RUN) {
    console.log(`--- DRY RUN clear reply for ${line}/${direction} ---\n${text}`);
    return;
  }

  const agent = await agentGetter();
  const replyRef = await resolveReplyRef(agent, recentPulse.post_uri);
  if (!replyRef) {
    console.warn(`[${line}/${direction}] could not resolve reply ref for clear post`);
    return;
  }
  const result = await postText(agent, text, replyRef);
  console.log(`Posted pulse clear ${line}/${direction}: ${result.url}`);
  recordDisruption({
    kind: 'train', line, direction,
    fromStation, toStation,
    source: 'observed-clear', posted: true, postUri: result.uri,
  });
}

async function findOpenAlertReplyRef(agent, line) {
  const code = LINE_TO_RAIL_ROUTE[line];
  if (!code) return null;
  const row = getDb().prepare(`
    SELECT post_uri FROM alert_posts
    WHERE kind = 'train' AND resolved_ts IS NULL
      AND post_uri IS NOT NULL
      AND (',' || routes || ',') LIKE ?
    ORDER BY first_seen_ts DESC LIMIT 1
  `).get(`%,${code},%`);
  if (!row || !row.post_uri) return null;
  return resolveReplyRef(agent, row.post_uri);
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

  rolloffOldObservations();

  try {
    await getAllTrainPositions();
  } catch (e) {
    console.warn(`getAllTrainPositions failed: ${e.message}`);
  }

  const sinceTs = now - LOOKBACK_MS;
  const allRecent = getRecentTrainPositions(sinceTs);

  if (allRecent.length === 0) {
    console.log('pulse: no train observations in lookback window — skipping');
    return;
  }
  const distinctTs = new Set(allRecent.map((r) => r.ts)).size;
  if (distinctTs < MIN_DISTINCT_TS) {
    console.log(`pulse: only ${distinctTs} distinct snapshot(s) in lookback (need ${MIN_DISTINCT_TS}) — warming up, skipping`);
    return;
  }

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  for (const line of ALL_LINES) {
    const recent = allRecent.filter((r) => r.line === line);
    // No signal → don't clear existing state based on missing data, just skip.
    if (recent.length === 0) continue;

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
      const rows = getDb().prepare('SELECT * FROM pulse_state WHERE line = ?').all(line);
      for (const row of rows) await handleClear(line, row.direction, agentGetter, now);
      continue;
    }

    // Detector returns at most one candidate per branch — handle each.
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

    // Stale pulse_state rows (no matching candidate this tick) get cleared.
    const rows = getDb().prepare('SELECT * FROM pulse_state WHERE line = ?').all(line);
    for (const row of rows) {
      if (!seenDirs.has(row.direction)) await handleClear(line, row.direction, agentGetter, now);
    }
  }
}

// Null destination → loop lines resolve line-wide; bi-directional lines return
// null and the detector falls back to its 15-min floor.
function safeHeadway(line) {
  try { return expectedTrainHeadwayMin(line, null); } catch (e) { return null; }
}

runBin(main);
