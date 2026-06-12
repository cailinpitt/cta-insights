#!/usr/bin/env node
// Metra hourly service rollup — cancellations (Phase 2) + delays (Phase 3). The
// cron entry is named metra-cancellations for historical reasons; it now posts a
// single combined digest.
//
// Posting model (decided — see plan-6-9-26.md §4.1c): service issues are NOT
// posted per-trip in real time. Every cancellation and significant delay is
// recorded to disruption_events as website-data-first (posted=0), and this job —
// run hourly, like the CTA ghost rollups — posts ONE digest of the per-line
// counts seen in the last hour to the Metra INSIGHTS account (@metrainsights /
// loginMetra). This mirrors the CTA split: the bot's own schedule-vs-reality
// detections (ghosts, gaps) post to the insights account (loginBus/loginTrain),
// while the alerts account is for republished official notices. Cancellation is
// the ghost analog and delay the gap analog, so both belong on the insights
// account. Silent when there's nothing. There is deliberately no per-incident
// thread/clear machinery: the post is a fire-and-forget summary; the website is
// the full record.
//
// Three signals:
//   - confirmed cancellation — Metra flagged the trip CANCELED. Authoritative.
//   - inferred cancellation  — a scheduled trip departed with no train ever seen
//     and no flag. Feed-health-gated; framed as unconfirmed.
//   - delay — a running train that hit the delay threshold (15+ min) this hour;
//     delay = predicted − scheduled, already captured per tick in
//     metra_trip_updates. The Metra analog of CTA gaps.

require('../../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');

const { setup, runBin } = require('../../src/shared/runBin');
const { detectCancellations, isFeedHealthy } = require('../../src/metra/cancellations');
const {
  computeMaxDelays,
  significantDelays,
  DELAY_THRESHOLD_SEC,
} = require('../../src/metra/delays');
const {
  scheduledDeparturesInWindow,
  chicagoDateStr,
  chicagoMidnightMs,
  tripKey,
} = require('../../src/metra/schedule');
const { getMetraAlerts } = require('../../src/metra/api');
const { lineLabel, LINE_NAMES } = require('../../src/metra/lines');
const { loginMetra, postText } = require('../../src/metra/bluesky');
const { resolveReplyRef } = require('../../src/shared/bluesky');
const { graphemeLength } = require('../../src/shared/post');
const { runNumberFromTripId } = require('../../src/metra/cancellationAlert');
const {
  getMetraCanceledTrips,
  getMetraObservedTripIds,
  getMetraLivePredictionTripIds,
  getMetraLatestPredictions,
  getMetraSnapshotTimestamps,
} = require('../../src/shared/observations');
const { recordDisruption, getMetraRecordedTripIds } = require('../../src/shared/history');
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
// enriched event record (a cancellation or a delay — its `source` decides the
// evidence shape). Resolves stop ids to names via the index.
function toDisruption(event, index) {
  const stops = index?.stops || {};
  const origin = event.originStopId ? stops[event.originStopId]?.name || null : null;
  const dest = event.headsign || (event.destStopId ? stops[event.destStopId]?.name || null : null);
  const evidence = {
    tripId: event.tripId,
    serviceDate: event.serviceDate,
    scheduledDepTs: event.scheduledDepMs ?? null,
    scheduledDepLabel: depLabel(event.scheduledDepMs),
    headsign: event.headsign ?? null,
    origin,
  };
  if (event.source === 'delay') {
    evidence.delaySec = event.delaySec ?? null;
    evidence.delayMin = event.delayMin ?? null;
  } else {
    evidence.inferred = event.source === 'cancellation-inferred';
  }
  return {
    kind: 'metra',
    line: event.route,
    direction: event.directionId != null ? String(event.directionId) : null,
    fromStation: origin,
    toStation: dest,
    source: event.source,
    posted: 0,
    evidence,
  };
}

const ROLLUP_HEADER = '🚆 Metra · past hour';
const ROLLUP_FOOTER = 'Per Metra realtime data.';

// Most train numbers to list per line before collapsing the rest into "+N more".
// Keeps a single line's bullet bounded; a line with this many affected trains in
// one hour is already an extreme outlier.
const TRAIN_CAP = 6;
// Per-post budget, leaving headroom for the rollup header (~22) AND footer (~26)
// both landing on the same post when there's only one. Header/footer are added at
// assembly; keeping each section post ≤ this guarantees ≤ 300 graphemes.
const SECTION_BUDGET = 250;

// Delay severity tiers, worst-first: [minInclusive, maxExclusive, label]. Every
// delay event is ≥ DELAY_THRESHOLD (15 min), so 15–29 is the floor.
const DELAY_BUCKETS = [
  [60, Number.POSITIVE_INFINITY, '60+ min'],
  [45, 60, '45–59 min'],
  [30, 45, '30–44 min'],
  [15, 30, '15–29 min'],
];

// Train number (rider-facing run number) parsed from the trip_id — works for every
// event including inferred cancellations, which never appear in the live feed.
const trainNo = (e) => runNumberFromTripId(e.tripId);
const numOf = (e) => Number(trainNo(e)) || 0;

// Bullets for a bucket of events: one line per affected route (busiest first, then
// alphabetical), listing its specific train numbers in ascending order. A line over
// TRAIN_CAP trains shows the first few then "+N more"; the per-line count is implicit
// in the list.
function renderBullets(events) {
  const byRoute = new Map();
  for (const e of events) {
    if (!byRoute.has(e.route)) byRoute.set(e.route, []);
    byRoute.get(e.route).push(e);
  }
  const rows = [...byRoute.entries()].map(([route, evs]) => ({
    name: LINE_NAMES[route] || route,
    evs,
  }));
  rows.sort((a, b) => b.evs.length - a.evs.length || a.name.localeCompare(b.name));

  return rows.map(({ name, evs }) => {
    let parts = [...evs]
      .sort((a, b) => numOf(a) - numOf(b))
      .map((e) => (trainNo(e) ? `#${trainNo(e)}` : null))
      .filter(Boolean);
    let suffix = '';
    if (parts.length > TRAIN_CAP) {
      suffix = `, +${parts.length - TRAIN_CAP} more`;
      parts = parts.slice(0, TRAIN_CAP);
    }
    // Fallback if no trip_id resolved to a number (shouldn't happen for Metra ids).
    return parts.length === 0 ? `• ${name}` : `• ${name}: ${parts.join(', ')}${suffix}`;
  });
}

// Pack a heading + flat bullet list into one or more post bodies under `budget`.
// The heading leads the first; bullets that spill repeat it with "(cont.)" so a
// continuation reads in context. Used for the cancellation + not-seen sections.
function packSection(heading, bullets, budget) {
  const posts = [];
  let i = 0;
  let first = true;
  while (i < bullets.length) {
    let body = first ? heading : `${heading} (cont.)`;
    let placed = 0;
    while (i < bullets.length) {
      const candidate = `${body}\n${bullets[i]}`;
      if (placed > 0 && graphemeLength(candidate) > budget) break;
      body = candidate;
      i++;
      placed++;
    }
    posts.push(body);
    first = false;
  }
  return posts;
}

// The delay post(s): a single "🐌 Delays" post with the severity tiers as
// sub-sections (worst tier first), train numbers under each. The bucket header
// conveys the magnitude, so per-train minutes are omitted. On a heavy hour it spills
// into "🐌 Delays (cont.)" replies; a tier sub-heading always travels with at least
// one of its bullets (never orphaned at a post boundary).
function buildDelayPosts(delays, budget) {
  const within = (e, lo, hi) => (e.delayMin ?? 0) >= lo && (e.delayMin ?? 0) < hi;
  const tiers = DELAY_BUCKETS.map(([lo, hi, label]) => ({
    label,
    bullets: renderBullets(delays.filter((e) => within(e, lo, hi))),
  })).filter((t) => t.bullets.length > 0);
  if (tiers.length === 0) return [];

  const HEAD = '🐌 Delays';
  const posts = [];
  let body = HEAD;
  const onlyHeading = () => body === HEAD || body === `${HEAD} (cont.)`;
  for (const { label, bullets } of tiers) {
    for (let j = 0; j < bullets.length; j++) {
      const piece = j === 0 ? `\n\n${label}\n${bullets[j]}` : `\n${bullets[j]}`;
      if (!onlyHeading() && graphemeLength(body + piece) > budget) {
        posts.push(body);
        body = `${HEAD} (cont.)\n\n${label}\n${bullets[j]}`; // re-attach the tier label
      } else {
        body += piece;
      }
    }
  }
  posts.push(body);
  return posts;
}

// The hourly digest as an array of post bodies for a thread: one post per non-empty
// issue type (a heavy type can spill into "(cont.)" replies), so each signal stands
// on its own rather than crowding one busy post. Cancellations + not-seen lead
// (worst-first); the delay tiers share one "🐌 Delays" post. The header leads the
// root and the provenance footer closes the last post; neither repeats. Empty → [].
function buildRollupPosts(confirmed, inferred, delays) {
  const posts = [];
  for (const [events, emoji, title] of [
    [confirmed, '❌', 'Cancelled'],
    [inferred, '⚠️', 'Scheduled but not seen (unconfirmed)'],
  ]) {
    const bullets = renderBullets(events);
    if (bullets.length > 0) {
      posts.push(...packSection(`${emoji} ${title}`, bullets, SECTION_BUDGET));
    }
  }
  posts.push(...buildDelayPosts(delays, SECTION_BUDGET));
  if (posts.length === 0) return [];

  posts[0] = `${ROLLUP_HEADER}\n\n${posts[0]}`;
  posts[posts.length - 1] = `${posts[posts.length - 1]}\n\n${ROLLUP_FOOTER}`;
  return posts;
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
  // Keyed by the suffix-agnostic trip key so realtime ids (which carry a
  // different service suffix than the static index) resolve to their schedule.
  const tripByKey = new Map(allTrips.map((t) => [tripKey(t.tripId), t]));
  const candidateTrips = allTrips.filter(
    (t) => t.scheduledDepMs >= now - ROLLUP_WINDOW_MS - GRACE_MS,
  );
  // Merge a raw realtime event ({tripId, route, …}) with its static schedule
  // record (headsign, scheduled departure, origin/dest, direction) via the trip
  // key; the raw fields (e.g. delaySec) win. Falls back to the raw event alone.
  const enrich = (raw) => {
    const base = tripByKey.get(tripKey(raw.tripId));
    return base ? { ...base, ...raw } : { serviceDate: chicagoDateStr(now), ...raw };
  };

  // Confirmed cancellations Metra flagged in the window, enriched from the index.
  const canceledTrips = getMetraCanceledTrips(now - ROLLUP_WINDOW_MS).map(enrich);

  // Context sets, normalized into the suffix-agnostic key space (the live feed
  // tags trips with a different service suffix than the static index — see
  // schedule.js#tripKey), or every scheduled train reads as unobserved.
  const keys = (set) => new Set([...set].map(tripKey));
  const observedTripIds = keys(getMetraObservedTripIds(now - DAY_LOOKBACK_MS));
  const livePredictionTripIds = keys(getMetraLivePredictionTripIds(now - DAY_LOOKBACK_MS));
  const alertCoveredTripIds = keys(await fetchAlertCoveredTripIds());
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
    keyOf: tripKey,
  });

  // Delays: trains that hit 15+ min late this hour. Metra's feed delay field is
  // always 0, so we compute delay = predicted − scheduled ourselves. The resolver
  // maps a realtime (trip, stop) to its scheduled arrival POSIX via the static
  // index (trip matched suffix-agnostically; stop by id; serviceDate → midnight).
  const scheduledArrFor = (rtTripId, stopId) => {
    const rec = tripByKey.get(tripKey(rtTripId));
    if (!rec) return null;
    const staticTrip = index.trips[rec.tripId];
    const st = staticTrip?.stop_times?.find((s) => s.stop_id === stopId);
    if (st?.arrival == null) return null;
    return chicagoMidnightMs(rec.serviceDate) / 1000 + st.arrival;
  };
  const maxDelays = computeMaxDelays(
    getMetraLatestPredictions(now - ROLLUP_WINDOW_MS),
    scheduledArrFor,
  );
  const delaysDetected = significantDelays(maxDelays);

  // Dedup against what's already been recorded for the relevant service dates, so
  // an event logged on an earlier hourly run isn't recorded or counted twice.
  // Cancellations and delays dedup against their own source buckets.
  const serviceDates = new Set(
    candidateTrips.map((t) => t.serviceDate).concat(chicagoDateStr(now)),
  );
  const recordedKeys = (sources) => {
    const set = new Set();
    for (const d of serviceDates)
      for (const id of getMetraRecordedTripIds(d, sources)) set.add(tripKey(id));
    return set;
  };
  const recordedCx = recordedKeys(['cancellation', 'cancellation-inferred']);
  const recordedDelay = recordedKeys(['delay']);
  const newConfirmed = confirmed.filter((t) => !recordedCx.has(tripKey(t.tripId)));
  const newInferred = inferred.filter((t) => !recordedCx.has(tripKey(t.tripId)));
  const newDelays = delaysDetected.filter((d) => !recordedDelay.has(tripKey(d.tripId))).map(enrich);

  console.log(
    `metra service rollup: ${newConfirmed.length} confirmed, ${newInferred.length} inferred, ${newDelays.length} delayed (≥${DELAY_THRESHOLD_SEC / 60}min) (feed ${feedHealthy ? 'healthy' : 'STALE'})`,
  );

  const all = [...newConfirmed, ...newInferred, ...newDelays];
  const posts = buildRollupPosts(newConfirmed, newInferred, newDelays);

  if (DRY_RUN) {
    for (const t of all) {
      const detail =
        t.source === 'delay'
          ? `~${t.delayMin}min late`
          : `dep ${depLabel(t.scheduledDepMs) || '?'}`;
      console.log(
        `  [${t.source}] ${lineLabel(t.route)} ${t.tripId} ${detail} → ${t.headsign || '?'}`,
      );
    }
    if (posts.length === 0) {
      console.log('\n--- DRY RUN rollup (DB write skipped) ---\n(silent — nothing this hour)');
    } else {
      posts.forEach((text, i) => {
        console.log(`\n--- DRY RUN post ${i + 1}/${posts.length} (DB write skipped) ---\n${text}`);
      });
    }
    return;
  }

  // Record every new event (website-data-first), then post the digest.
  for (const t of all) recordDisruption(toDisruption(t, index), now);

  if (posts.length === 0) {
    console.log('metra service rollup: nothing this hour — staying silent');
    return;
  }

  // Thread continuations under the root, like the CTA ghost rollup.
  const agent = await loginMetra();
  let replyRef = null;
  for (let i = 0; i < posts.length; i++) {
    const result = await postText(agent, posts[i], replyRef);
    console.log(`Posted metra service rollup ${i + 1}/${posts.length}: ${result.url}`);
    if (i < posts.length - 1) replyRef = await resolveReplyRef(agent, result.uri);
  }
}

if (require.main === module) {
  runBin(main);
}

module.exports = { buildRollupPosts, renderBullets, buildDelayPosts, packSection, toDisruption };
