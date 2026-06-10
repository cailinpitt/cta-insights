#!/usr/bin/env node
// Metra cancellation detection + hourly rollup. The flagship Phase 2 job.
//
// Posting model (decided — see plan-6-9-26.md §4.1c): cancellations are NOT
// posted per-trip in real time. Instead, every cancellation (confirmed +
// inferred) is recorded to disruption_events as website-data-first (posted=0),
// and this job — run hourly, like the CTA ghost rollups — posts ONE digest of
// the per-line counts seen in the last hour to the Metra alerts account. Silent
// when there's nothing. There is deliberately no per-incident thread/clear
// machinery: the post is a fire-and-forget summary; the website is the full record.
//
// Two detection layers (src/metra/cancellations.js):
//   - confirmed  — Metra flagged the trip CANCELED. Authoritative.
//   - inferred   — a scheduled trip departed with no train ever seen and no flag.
//     Gated behind a feed-health check so a feed stall isn't read as mass
//     cancellation, and framed as unconfirmed in the post.

require('../../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');

const { setup, runBin } = require('../../src/shared/runBin');
const { detectCancellations, isFeedHealthy } = require('../../src/metra/cancellations');
const { scheduledDeparturesInWindow, chicagoDateStr } = require('../../src/metra/schedule');
const { getMetraAlerts } = require('../../src/metra/api');
const { lineLabel, LINE_NAMES } = require('../../src/metra/lines');
const { loginMetraAlerts, postText } = require('../../src/metra/bluesky');
const {
  getMetraCanceledTrips,
  getMetraObservedTripIds,
  getMetraLivePredictionTripIds,
  getMetraSnapshotTimestamps,
} = require('../../src/shared/observations');
const { recordDisruption, getMetraCancelledTripIds } = require('../../src/shared/history');
const { formatTimeCT } = require('../../src/shared/format');

const DRY_RUN = process.env.METRA_DRY_RUN === '1' || process.argv.includes('--dry-run');

// The rollup reports "the last hour"; the window is slightly wider so a late
// cron tick doesn't drop cancellations between runs (dedup keeps overlap safe).
const ROLLUP_WINDOW_MS = 70 * 60 * 1000;
const DAY_LOOKBACK_MS = 20 * 60 * 60 * 1000; // "ran at all today" / schedule span
const GRACE_MS = 15 * 60 * 1000;

function loadIndex() {
  try {
    const p = Path.join(__dirname, '..', '..', 'data', 'metra-gtfs', 'index.json');
    return JSON.parse(Fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function depLabel(ms) {
  return ms ? formatTimeCT(new Date(ms)) : null;
}

// Build the evidence + segment fields for a disruption_events row from an
// enriched trip record. Resolves stop ids to names via the index.
function toDisruption(trip, index, source) {
  const stops = index?.stops || {};
  const origin = trip.originStopId ? stops[trip.originStopId]?.name || null : null;
  const dest = trip.headsign || (trip.destStopId ? stops[trip.destStopId]?.name || null : null);
  return {
    kind: 'metra',
    line: trip.route,
    direction: trip.directionId != null ? String(trip.directionId) : null,
    fromStation: origin,
    toStation: dest,
    source,
    posted: 0,
    evidence: {
      tripId: trip.tripId,
      serviceDate: trip.serviceDate,
      scheduledDepTs: trip.scheduledDepMs ?? null,
      scheduledDepLabel: depLabel(trip.scheduledDepMs),
      headsign: trip.headsign ?? null,
      origin,
      inferred: source === 'cancellation-inferred',
    },
  };
}

// "BNSF 2 · UP-N 1" sorted by count desc then line order.
function tally(events) {
  const counts = new Map();
  for (const e of events) counts.set(e.route, (counts.get(e.route) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([route, n]) => `${LINE_NAMES[route] || route} ${n}`)
    .join(' · ');
}

function buildRollupText(confirmed, inferred) {
  const lines = ['🚆 Metra cancellations · last hour', ''];
  if (confirmed.length > 0) {
    lines.push(tally(confirmed));
  } else {
    lines.push('No confirmed cancellations.');
  }
  if (inferred.length > 0) {
    lines.push('');
    lines.push(
      `⚠️ ${inferred.length} more scheduled ${inferred.length === 1 ? 'train' : 'trains'} not seen running (unconfirmed): ${tally(inferred)}`,
    );
  }
  lines.push('');
  lines.push('Per Metra realtime data.');
  return lines.join('\n');
}

async function fetchAlertCoveredTripIds() {
  try {
    const alerts = await getMetraAlerts();
    const set = new Set();
    for (const a of alerts) {
      for (const e of a.informedEntities || []) if (e.tripId) set.add(e.tripId);
    }
    return set;
  } catch (e) {
    console.warn(
      `metra cancellations: alert fetch failed (${e.message}); continuing without alert cover`,
    );
    return new Set();
  }
}

async function main() {
  setup();
  const now = Date.now();
  const index = loadIndex();
  if (!index) {
    console.error('metra cancellations: schedule index missing — run fetch-metra-gtfs first');
    return;
  }

  // Schedule: every trip whose departure lands across the service day, mapped by
  // trip_id (enriches confirmed cancellations); the recent slice is the inferred
  // candidate pool.
  const allTrips = scheduledDeparturesInWindow(
    index,
    now - DAY_LOOKBACK_MS,
    now + 2 * 60 * 60 * 1000,
    now,
  );
  const tripById = new Map(allTrips.map((t) => [t.tripId, t]));
  const candidateTrips = allTrips.filter(
    (t) => t.scheduledDepMs >= now - ROLLUP_WINDOW_MS - GRACE_MS,
  );

  // Confirmed cancellations Metra flagged in the window, enriched from the index.
  const canceledRaw = getMetraCanceledTrips(now - ROLLUP_WINDOW_MS);
  const canceledTrips = canceledRaw.map(
    (c) =>
      tripById.get(c.tripId) || {
        tripId: c.tripId,
        route: c.route,
        serviceDate: chicagoDateStr(now),
      },
  );

  // Context sets.
  const observedTripIds = getMetraObservedTripIds(now - DAY_LOOKBACK_MS);
  const livePredictionTripIds = getMetraLivePredictionTripIds(now - DAY_LOOKBACK_MS);
  const alertCoveredTripIds = await fetchAlertCoveredTripIds();
  const feedHealthy = isFeedHealthy(getMetraSnapshotTimestamps(now - 30 * 60 * 1000), now);
  if (!feedHealthy) {
    console.warn('metra cancellations: feed unhealthy — inferred layer suppressed this run');
  }

  const { confirmed, inferred } = detectCancellations({
    canceledTrips,
    candidateTrips,
    observedTripIds,
    livePredictionTripIds,
    alertCoveredTripIds,
    now,
    graceMs: GRACE_MS,
    feedHealthy,
  });

  // Dedup against what's already been recorded this/yesterday's service date so a
  // cancellation logged on an earlier hourly run isn't recorded or counted twice.
  const recorded = new Set();
  for (const d of new Set(candidateTrips.map((t) => t.serviceDate).concat(chicagoDateStr(now)))) {
    for (const id of getMetraCancelledTripIds(d)) recorded.add(id);
  }
  const newConfirmed = confirmed.filter((t) => !recorded.has(t.tripId));
  const newInferred = inferred.filter((t) => !recorded.has(t.tripId));

  console.log(
    `metra cancellations: ${newConfirmed.length} new confirmed, ${newInferred.length} new inferred (feed ${feedHealthy ? 'healthy' : 'STALE'})`,
  );

  if (DRY_RUN) {
    for (const t of [...newConfirmed, ...newInferred]) {
      console.log(
        `  [${t.source}] ${lineLabel(t.route)} ${t.tripId} dep ${depLabel(t.scheduledDepMs) || '?'} → ${t.headsign || '?'}`,
      );
    }
    const text =
      newConfirmed.length + newInferred.length > 0
        ? buildRollupText(newConfirmed, newInferred)
        : '(silent — nothing this hour)';
    console.log(`\n--- DRY RUN rollup (DB write skipped) ---\n${text}`);
    return;
  }

  // Record every new cancellation (website-data-first), then post the digest.
  for (const t of [...newConfirmed, ...newInferred]) {
    recordDisruption(toDisruption(t, index, t.source), now);
  }

  if (newConfirmed.length === 0 && newInferred.length === 0) {
    console.log('metra cancellations: nothing this hour — staying silent');
    return;
  }

  const text = buildRollupText(newConfirmed, newInferred);
  const agent = await loginMetraAlerts();
  const result = await postText(agent, text);
  console.log(`Posted metra cancellation rollup: ${result.url}`);
}

if (require.main === module) {
  runBin(main);
}

module.exports = { buildRollupText, tally, toDisruption };
