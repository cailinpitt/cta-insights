#!/usr/bin/env node
// Posts when a candidate dead segment overlaps the previous tick's run by
// ≥50% for MIN_CONSECUTIVE_TICKS. Clears state after CLEAR_TICKS_TO_RESET
// clean ticks. Per-(line, direction) state lives in pulse_state — including
// `active_post_uri` which pins the canonical post for the current outage so
// re-posts of the same incident are suppressed and the eventual ✅ clear
// targets the right thread.
//
// Cooldown key derives from the bracketing stations via stableSegmentTag()
// — single-bin drift between ticks no longer changes the key, so the
// cooldown actually suppresses re-posts.
//
// When a line has zero observations but other lines do and GTFS says
// service should be running, the bin synthesizes a full-branch candidate
// (synthetic: true) so a whole-line blackout (e.g. shuttle replacement)
// can still be flagged.
//
// Cold-start guards (`MIN_DISTINCT_TS`, the detector's coverage/span gates)
// stop a freshly-bootstrapped observations table from looking like a
// system-wide outage. Set PULSE_DRY_RUN=1 to exercise the full detection
// path without posting — recommended after any deploy that touches this code.

require('../../src/shared/env');

const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const {
  detectDeadSegments,
  directionKeyFor,
  stationsAlongBranch,
} = require('../../src/train/pulse');
const { buildLineBranches } = require('../../src/train/speedmap');
const { getAllTrainPositions, LINE_COLORS, ALL_LINES } = require('../../src/train/api');
const {
  loginAlerts,
  postWithImage,
  postText,
  resolveReplyRef,
} = require('../../src/shared/bluesky');
const { renderDisruption } = require('../../src/map');
const { buildPostText, buildAltText, buildClearPostText } = require('../../src/shared/disruption');
const {
  expectedTrainHeadwayMin,
  expectedTrainActiveTrips,
  expectedTrainActiveTripsAnyDir,
} = require('../../src/shared/gtfs');
const { getRecentTrainPositions, getLineCorridorBbox } = require('../../src/shared/observations');
const { acquireCooldown } = require('../../src/shared/state');
const {
  getPulseState,
  upsertPulseState,
  clearPulseState,
  recordDisruption,
  hasObservedClearForPulse,
  hasUnresolvedCtaAlert,
  getDb,
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
    timeZone: 'America/Chicago',
    hourCycle: 'h23',
    hour: '2-digit',
  }).format(now);
  return parseInt(h, 10) % 24;
}

function slugStation(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// Cooldown key derives from the bracketing stations rather than raw ft
// boundaries — single-bin drift between ticks no longer changes the key, so
// the cooldown actually suppresses re-posts of the same outage.
function stableSegmentTag(candidate) {
  return `${slugStation(candidate.fromStation.name)}__${slugStation(candidate.toStation.name)}`;
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

  const segmentTag = stableSegmentTag(candidate);
  const cooldownKey = `train_pulse_${line}_${direction}_${segmentTag}`;
  const activePostUri = prior?.active_post_uri || null;
  const activePostTs = prior?.active_post_ts || null;

  upsertPulseState({
    line,
    direction,
    runLoFt: candidate.runLoFt,
    runHiFt: candidate.runHiFt,
    fromStation: candidate.fromStation.name,
    toStation: candidate.toStation.name,
    startedTs,
    lastSeenTs: now,
    consecutiveTicks: consecutive,
    clearTicks: 0,
    postedCooldownKey: cooldownKey,
    activePostUri,
    activePostTs,
  });

  if (activePostUri) {
    console.log(
      `[${line}/${direction}] active pulse ${activePostUri} still in effect — refreshing state, no re-post`,
    );
    return;
  }

  if (consecutive < MIN_CONSECUTIVE_TICKS) {
    console.log(
      `[${line}/${direction}] candidate ${candidate.fromStation.name}→${candidate.toStation.name} tick ${consecutive}/${MIN_CONSECUTIVE_TICKS}`,
    );
    return;
  }

  const disruption = {
    line,
    suspendedSegment: {
      from: candidate.fromStation.name,
      to: candidate.toStation.name,
    },
    directionHint: candidate.directionHint || null,
    alternative: null,
    reason: null,
    source: 'observed',
    detectedAt: now,
    evidence: {
      runLengthMi: Math.round((candidate.runLengthFt / 5280) * 10) / 10,
      minutesSinceLastTrain:
        candidate.lastSeenInRunMs != null
          ? Math.round((now - candidate.lastSeenInRunMs) / 60000)
          : null,
      lookbackMin: Math.round(candidate.lookbackMs / 60000),
      coldThresholdMin: Math.round(candidate.coldThresholdMs / 60000),
      trainsOutsideRun: candidate.trainsOutsideRun,
      coldStations: candidate.coldStations,
      coldStationNames: candidate.coldStationNames,
      expectedTrains: candidate.expectedTrains,
      synthetic: candidate.synthetic === true,
    },
  };

  if (DRY_RUN) {
    let image = null;
    try {
      image = await renderDisruption({
        disruption,
        trainLines,
        lineColors: LINE_COLORS,
        trains: [],
        stations: trainStations,
      });
    } catch (e) {
      console.warn(`renderDisruption failed: ${e.message}`);
    }
    const ctaCode = LINE_TO_RAIL_ROUTE[line];
    const dryCtaAlertOpen = !!(
      ctaCode && hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: ctaCode })
    );
    const text = buildPostText(disruption, { ctaAlertOpen: dryCtaAlertOpen });
    const alt = buildAltText(disruption);
    const stub = image
      ? writeDryRunAsset(image, `pulse-${line}-${direction}-${now}.jpg`)
      : '(render failed)';
    console.log(
      `--- DRY RUN pulse ${line}/${direction} ---\n${text}\n\nAlt: ${alt}\nImage: ${stub}`,
    );
    recordDisruption({
      kind: 'train',
      line,
      direction,
      fromStation: candidate.fromStation.name,
      toStation: candidate.toStation.name,
      source: 'observed',
      posted: false,
      postUri: null,
    });
    return;
  }

  if (!acquireCooldown(cooldownKey, now, POST_COOLDOWN_MS)) {
    console.log(`[${line}/${direction}] on cooldown ${cooldownKey}, skipping`);
    recordDisruption({
      kind: 'train',
      line,
      direction,
      fromStation: candidate.fromStation.name,
      toStation: candidate.toStation.name,
      source: 'observed',
      posted: false,
      postUri: null,
    });
    return;
  }

  let image;
  try {
    image = await renderDisruption({
      disruption,
      trainLines,
      lineColors: LINE_COLORS,
      trains: [],
      stations: trainStations,
    });
  } catch (e) {
    console.error(`renderDisruption failed for ${line}: ${e.stack || e.message}`);
    return;
  }

  const agent = await agentGetter();
  const replyRef = await findOpenAlertReplyRef(agent, line, candidate);
  // Build text AFTER we know whether a CTA alert is in the thread, so the
  // footer reflects reality ("see CTA alert above") instead of always
  // claiming CTA hasn't published one.
  const ctaAlertOpen = !!replyRef;
  const text = buildPostText(disruption, { ctaAlertOpen });
  const alt = buildAltText(disruption);

  const result = await postWithImage(agent, text, image, alt, replyRef);
  console.log(`Posted pulse ${line}/${direction}: ${result.url}`);
  recordDisruption({
    kind: 'train',
    line,
    direction,
    fromStation: candidate.fromStation.name,
    toStation: candidate.toStation.name,
    source: 'observed',
    posted: true,
    postUri: result.uri,
  });
  // Pin the canonical post for this outage. Subsequent ticks see active_post_uri
  // and skip; the eventual clear targets this URI directly.
  upsertPulseState({
    line,
    direction,
    runLoFt: candidate.runLoFt,
    runHiFt: candidate.runHiFt,
    fromStation: candidate.fromStation.name,
    toStation: candidate.toStation.name,
    startedTs,
    lastSeenTs: now,
    consecutiveTicks: consecutive,
    clearTicks: 0,
    postedCooldownKey: cooldownKey,
    activePostUri: result.uri,
    activePostTs: now,
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
// again. Targets `prior.active_post_uri` directly — no time-window lookup,
// so multi-day outages still land their ✅ on the canonical pulse post.
async function postClearReply(line, direction, prior, agentGetter) {
  if (!prior?.active_post_uri) return;
  const fromStation = prior.from_station;
  const toStation = prior.to_station;
  if (!fromStation || !toStation) return;

  if (hasObservedClearForPulse({ kind: 'train', pulseUri: prior.active_post_uri })) {
    console.log(
      `[${line}/${direction}] clear reply already posted for ${prior.active_post_uri} — skipping`,
    );
    return;
  }

  const ctaCode = LINE_TO_RAIL_ROUTE[line];
  const ctaAlertOpen = !!(
    ctaCode && hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: ctaCode })
  );

  const disruption = { line, suspendedSegment: { from: fromStation, to: toStation } };
  const text = buildClearPostText(disruption, { ctaAlertOpen });

  if (DRY_RUN) {
    console.log(`--- DRY RUN clear reply for ${line}/${direction} ---\n${text}`);
    return;
  }

  const agent = await agentGetter();
  // Prefer threading the ✅ under the most recent open CTA alert in the thread
  // (resolveReplyRef walks up the reply chain, so root stays pinned to the
  // original pulse). Falls back to the pulse post itself when no CTA alert
  // joined the thread.
  const candidateForLookup = { fromStation: { name: fromStation }, toStation: { name: toStation } };
  const replyRef =
    (await findOpenAlertReplyRef(agent, line, candidateForLookup)) ||
    (await resolveReplyRef(agent, prior.active_post_uri));
  if (!replyRef) {
    console.warn(`[${line}/${direction}] could not resolve reply ref for clear post`);
    return;
  }
  const result = await postText(agent, text, replyRef);
  console.log(`Posted pulse clear ${line}/${direction}: ${result.url}`);
  recordDisruption({
    kind: 'train',
    line,
    direction,
    fromStation,
    toStation,
    source: 'observed-clear',
    posted: true,
    postUri: result.uri,
  });
}

// Score top-N unresolved alerts by station-overlap with the candidate so a
// recent unrelated alert on the same line doesn't grab the thread root.
async function findOpenAlertReplyRef(agent, line, candidate) {
  const code = LINE_TO_RAIL_ROUTE[line];
  if (!code) return null;
  const rows = getDb()
    .prepare(`
    SELECT post_uri, headline FROM alert_posts
    WHERE kind = 'train' AND resolved_ts IS NULL
      AND post_uri IS NOT NULL
      AND (',' || routes || ',') LIKE ?
    ORDER BY first_seen_ts DESC LIMIT 5
  `)
    .all(`%,${code},%`);
  if (rows.length === 0) return null;
  const fromName = candidate?.fromStation?.name?.toLowerCase() || '';
  const toName = candidate?.toStation?.name?.toLowerCase() || '';
  const scored = rows.map((r) => {
    const h = (r.headline || '').toLowerCase();
    let score = 0;
    if (fromName && h.includes(fromName)) score++;
    if (toName && h.includes(toName)) score++;
    return { ...r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return resolveReplyRef(agent, scored[0].post_uri);
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
    activePostUri: prior.active_post_uri,
    activePostTs: prior.active_post_ts,
  };
}

async function main() {
  setup();
  const now = Date.now();

  console.log(
    `train-pulse: scanning ${ALL_LINES.length} rail lines for cold segments (lookback=${LOOKBACK_MS / 60000} min, ` +
      `posts after ${MIN_CONSECUTIVE_TICKS} consecutive ticks of ≥50% overlap, clears after ${CLEAR_TICKS_TO_RESET} clean ticks)`,
  );

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
    console.log(
      `train-pulse: no train positions recorded in last ${LOOKBACK_MS / 60000} min across any line — skipping (likely upstream snapshot/API issue)`,
    );
    return;
  }
  const distinctTs = new Set(allRecent.map((r) => r.ts)).size;
  if (distinctTs < MIN_DISTINCT_TS) {
    console.log(
      `train-pulse: only ${distinctTs} distinct snapshot(s) in last ${LOOKBACK_MS / 60000} min (need ${MIN_DISTINCT_TS}) — warming up, skipping`,
    );
    return;
  }

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  const tally = {
    evaluated: 0,
    noObs: 0,
    windDown: 0,
    syntheticChecked: 0,
    candidates: 0,
    skippedDetector: 0,
  };

  for (const line of ALL_LINES) {
    tally.evaluated++;
    // GTFS says fewer than 1 trip active this hour on any direction → line is
    // winding down or between service hours. Don't false-flag the cold tail
    // behind the last train as an outage. Leave any open pulse_state intact:
    // advancing clears here would post a bogus "trains running again" reply
    // the moment scheduled service drops below 1 trip/hr (it's service ending,
    // not resuming). The next morning's normal detection will clear organically
    // if the outage has actually resolved.
    const MIN_EXPECTED_ACTIVE = 1;
    let expectedAnyDir = 0;
    try {
      expectedAnyDir = expectedTrainActiveTripsAnyDir(line, new Date(now));
    } catch (_e) {
      expectedAnyDir = 0;
    }
    if (expectedAnyDir < MIN_EXPECTED_ACTIVE) {
      tally.windDown++;
      console.log(
        `train-pulse: ${line} — winding down (GTFS expects ${expectedAnyDir} trips this hour, threshold ≥${MIN_EXPECTED_ACTIVE}); leaving any open pulse_state intact, no clear-tick advance`,
      );
      continue;
    }

    const recent = allRecent.filter((r) => r.line === line);
    // Corridor bbox over the last 6 hours — restricts detection to the actual
    // revenue track so the Purple Express portion (not running on weekends)
    // doesn't read as "cold" against the full Linden→Loop polyline.
    const CORRIDOR_LOOKBACK_MS = 6 * 60 * 60 * 1000;
    const corridorBbox = getLineCorridorBbox(line, now - CORRIDOR_LOOKBACK_MS);
    if (recent.length === 0) {
      tally.noObs++;
      tally.syntheticChecked++;
      await maybeSyntheticFullLineCandidate(line, allRecent, agentGetter, now, corridorBbox);
      continue;
    }

    const headwayMin = safeHeadway(line);

    let detection;
    try {
      detection = detectDeadSegments({
        line,
        trainLines,
        stations: trainStations,
        headwayMin,
        now,
        opts: {
          lookbackMs: LOOKBACK_MS,
          corridorBbox,
          recentPositions: recent.map((r) => ({
            ts: r.ts,
            lat: r.lat,
            lon: r.lon,
            rn: r.rn,
            trDr: r.trDr,
          })),
        },
      });
    } catch (e) {
      console.error(`pulse detect failed for ${line}: ${e.stack || e.message}`);
      continue;
    }

    if (detection.skipped) {
      tally.skippedDetector++;
      // Sparse-coverage doesn't mean the prior outage is still active — it
      // just means we can't evaluate cold bins this tick. If we have an open
      // pulse on this line and observations did arrive (just not enough to
      // hit the coverage threshold), advance clear-ticks anyway so a stale
      // FP doesn't stay pinned forever.
      if (detection.skipped === 'sparse-coverage' && recent.length > 0) {
        const rows = getDb()
          .prepare('SELECT * FROM pulse_state WHERE line = ? AND active_post_uri IS NOT NULL')
          .all(line);
        for (const row of rows) {
          await handleClear(line, row.direction, agentGetter, now);
        }
        if (rows.length > 0) {
          console.log(
            `train-pulse: ${line} — detector skipped (sparse-coverage) but advancing clear-ticks for ${rows.length} open pulse(s)`,
          );
          continue;
        }
      }
      console.log(
        `train-pulse: ${line} — detector skipped (${detection.skipped}); leaving pulse_state intact`,
      );
      continue;
    }

    if (detection.candidates.length === 0) {
      const rows = getDb().prepare('SELECT * FROM pulse_state WHERE line = ?').all(line);
      for (const row of rows) await handleClear(line, row.direction, agentGetter, now);
      continue;
    }

    const seenDirs = new Set();
    for (const c of detection.candidates) {
      if (seenDirs.has(c.direction)) continue;
      seenDirs.add(c.direction);
      tally.candidates++;
      try {
        await handleCandidate(line, c.direction, c, agentGetter, now);
      } catch (e) {
        console.error(`handleCandidate failed for ${line}/${c.direction}: ${e.stack || e.message}`);
      }
    }

    const rows = getDb().prepare('SELECT * FROM pulse_state WHERE line = ?').all(line);
    for (const row of rows) {
      if (!seenDirs.has(row.direction)) await handleClear(line, row.direction, agentGetter, now);
    }
  }

  console.log(
    `train-pulse: summary — evaluated ${tally.evaluated} lines: ${tally.windDown} winding down, ` +
      `${tally.noObs} with zero observations (${tally.syntheticChecked} checked for synthetic full-line candidate), ` +
      `${tally.skippedDetector} skipped by detector gates, ` +
      `${tally.candidates} dead-segment candidate(s) handed to handleCandidate`,
  );
}

// Bug 2: when an entire line goes dark (rail replaced by shuttles, signal
// failure across all interlockings) the API returns zero observations for it.
// If other lines have data and GTFS says service should be running, treat it
// as a full-branch candidate so pulse can flag the outage.
async function maybeSyntheticFullLineCandidate(line, allRecent, agentGetter, now, corridorBbox) {
  if (allRecent.length === 0) return; // pipeline-wide problem, not line-specific
  let expected = 0;
  try {
    expected = expectedTrainActiveTrips(line, null, new Date(now)) || 0;
  } catch (_e) {
    expected = 0;
  }
  if (expected <= 0) return;
  // Cold-start grace: if the line has had ZERO observations in the past 6
  // hours, this is service-not-yet-started (early morning, between owl and
  // commute) — not an outage. The first train of the day pulls out of its
  // terminal a few minutes after scheduled service start, and synthesizing
  // an alert in that gap produces an FP that resolves on its own ~5 min
  // later. The corridorBbox is a cheap proxy for "anything on this line
  // recently"; null means nothing in the last 6h.
  if (!corridorBbox) {
    console.log(
      `pulse: zero observations on line=${line} but ${expected} trips expected — within cold-start grace window (no obs in past 6h), skipping synthetic candidate`,
    );
    return;
  }
  console.log(
    `pulse: zero observations on line=${line} but ${expected} trips expected — synthesizing full-line candidate`,
  );
  const branches = buildLineBranches(trainLines, line);
  // Lines like Yellow ship mirror-segment polylines (Howard→Dempster +
  // Dempster→Howard) as two branches with no direction hint. Both represent
  // the same physical track; dedupe by unordered station-pair signature so
  // we don't post twice for one line-wide outage.
  const seenSignatures = new Set();
  for (let bi = 0; bi < branches.length; bi++) {
    const b = branches[bi];
    if (!b.totalFt) continue;
    let stationsOnBranch = stationsAlongBranchHelper(b, line);
    if (stationsOnBranch.length < 2) continue;
    // Restrict synthesized stations to the active corridor — for Purple on
    // weekends, GTFS may say 1+ trip/hr (the Linden-Howard shuttle), but the
    // polyline still spans Linden→Loop. Without this clip, the synthetic
    // candidate would name "Linden → Merchandise Mart" instead of "Linden →
    // Howard," and the rendered map would dim track that isn't running today.
    const inCorridor = stationsOnBranch.filter(
      (s) =>
        s.station.lat >= corridorBbox.minLat - 0.005 &&
        s.station.lat <= corridorBbox.maxLat + 0.005 &&
        s.station.lon >= corridorBbox.minLon - 0.005 &&
        s.station.lon <= corridorBbox.maxLon + 0.005,
    );
    if (inCorridor.length >= 2) stationsOnBranch = inCorridor;
    const direction = directionKeyFor(branches, bi, b.directionHint);
    const fromStation = stationsOnBranch[0].station;
    const toStation = stationsOnBranch[stationsOnBranch.length - 1].station;
    const signature = [fromStation.name, toStation.name].sort().join('||');
    if (seenSignatures.has(signature)) {
      console.log(
        `[${line}/${direction}] mirror-segment of an already-synthesized candidate — skipping`,
      );
      continue;
    }
    seenSignatures.add(signature);
    const synthetic = {
      line,
      direction,
      runLoFt: 0,
      runHiFt: b.totalFt,
      runLengthFt: b.totalFt,
      fromStation,
      toStation,
      coldBins: 0,
      totalBins: 0,
      observedTrainsInWindow: 0,
      lastSeenInRunMs: null,
      coldThresholdMs: LOOKBACK_MS,
      lookbackMs: LOOKBACK_MS,
      trainsOutsideRun: 0,
      coldStations: stationsOnBranch.length,
      coldStationNames: stationsOnBranch.map((s) => s.station.name),
      expectedTrains: expected,
      synthetic: true,
    };
    try {
      await handleCandidate(line, direction, synthetic, agentGetter, now);
    } catch (e) {
      console.error(`synthetic candidate failed for ${line}/${direction}: ${e.stack || e.message}`);
    }
  }
}

function stationsAlongBranchHelper(branch, line) {
  return stationsAlongBranch(trainStations, line, branch.points, branch.cumDist);
}

// Null destination → loop lines resolve line-wide; bi-directional lines return
// null and the detector falls back to its 15-min floor.
function safeHeadway(line) {
  try {
    return expectedTrainHeadwayMin(line, null);
  } catch (_e) {
    return null;
  }
}

module.exports = { chicagoHourNow, stableSegmentTag, overlapFraction };

if (require.main === module) runBin(main);
