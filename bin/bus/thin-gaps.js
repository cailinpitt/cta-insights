#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { names: routeNames, lowFrequency } = require('../../src/bus/routes');
const { detectThinGaps } = require('../../src/bus/thinGaps');
const {
  getBusObservations,
  getLastBusObservationTs,
  countDistinctTsInBusObservations,
} = require('../../src/shared/observations');
const {
  expectedBusRouteHeadwayMin,
  expectedBusRouteActiveTrips,
  loadIndex,
} = require('../../src/shared/gtfs');
const { recordMetaSignal, recordDisruption, getDb } = require('../../src/shared/history');
const { acquireCooldown, isOnCooldown } = require('../../src/shared/state');
const { loginBus, postText } = require('../../src/bus/bluesky');
const { buildRollupThread } = require('../../src/shared/post');
const { resolveReplyRef } = require('../../src/shared/bluesky');
const { setup, runBin } = require('../../src/shared/runBin');

// Daily cap mirrors the bus-gap channel — thin-gap posts share the same thread
// space and a single chronically-down route shouldn't dominate the feed.
const DAILY_CAP_KEY_TTL_MS = 24 * 60 * 60 * 1000;

// Observation pipeline health check: observeBuses runs */10, so 30 min should
// see ~3 distinct timestamps. Anything below MIN_HEALTHY_SNAPSHOTS means the
// pipeline is broken — bailing out prevents a system-wide observation outage
// from fanning out into 47 simultaneous false-positive posts.
const HEALTH_CHECK_WINDOW_MS = 30 * 60 * 1000;
const MIN_HEALTHY_SNAPSHOTS = 2;
const HOUR_MS = 60 * 60 * 1000;

// Max age of a thin-gap firing we'll still post a clear reply for. Beyond
// this the original thread is too cold for a "buses observed again" reply
// to read naturally to a follower scrolling by.
const CLEAR_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function findUnresolvedThinGaps(now) {
  return getDb()
    .prepare(`
      SELECT d.id, d.ts, d.line AS route, d.post_uri
      FROM disruption_events d
      WHERE d.kind = 'bus' AND d.source = 'observed-thin'
        AND d.posted = 1 AND d.post_uri IS NOT NULL
        AND d.ts >= ?
        AND NOT EXISTS (
          SELECT 1 FROM disruption_events c
          WHERE c.kind = 'bus' AND c.source = 'observed-clear' AND c.posted = 1
            AND c.line = d.line AND c.ts >= d.ts
        )
      ORDER BY d.ts ASC
    `)
    .all(now - CLEAR_LOOKBACK_MS);
}

function buildClearText(route) {
  const name = routeNames[route];
  const label = name ? `#${route} ${name}` : `#${route}`;
  return `🚌✅ ${label}: buses observed on the route again — earlier thin-service gap has cleared.`;
}

async function handleClears(now, agentGetter, dryRun) {
  const open = findUnresolvedThinGaps(now);
  if (open.length === 0) return;
  for (const row of open) {
    const route = row.route;
    // Any observation strictly after the firing ts counts as recovery. One
    // tick is enough — these are low-frequency routes, so even a single bus
    // sighting means real service, not a noisy snapshot.
    const obs = getBusObservations(route, row.ts + 1);
    if (!obs || obs.length === 0) continue;
    const firstObsTs = obs.reduce((m, o) => (o.ts < m ? o.ts : m), obs[0].ts);
    const text = buildClearText(route);
    if (dryRun) {
      console.log(`--- DRY RUN thin-gap clear ${route} ---\n${text}`);
      continue;
    }
    const agent = await agentGetter();
    const replyRef = await resolveReplyRef(agent, row.post_uri);
    if (!replyRef) {
      console.warn(
        `thin-gaps: could not resolve reply ref for ${row.post_uri} (route ${route}), skipping clear`,
      );
      continue;
    }
    const result = await postText(agent, text, replyRef);
    console.log(`Posted thin-gap clear ${route}: ${result.url}`);
    recordDisruption(
      {
        kind: 'bus',
        line: route,
        source: 'observed-clear',
        posted: true,
        postUri: result.uri,
      },
      firstObsTs,
    );
  }
}

function formatLine(event) {
  const name = routeNames[event.route];
  const title = name ? `Route ${event.route} (${name})` : `Route ${event.route}`;
  const headway = Math.round(event.headwayMin);
  const windowMin = Math.round(event.windowMin);
  return `🚌 ${title} · no buses observed in past ~${windowMin} min (scheduled every ~${headway} min)`;
}

function buildPostThread(events) {
  return buildRollupThread('🕳️ Thin-service gaps, past hour', events.map(formatLine));
}

async function main() {
  setup();

  const index = loadIndex();
  const unindexed = lowFrequency.filter((r) => !index.routes[r]);
  if (unindexed.length) {
    console.warn(
      `Routes missing from GTFS index (will be skipped): ${unindexed.join(', ')} — re-run scripts/fetch-gtfs.js`,
    );
  }

  const now = Date.now();

  // System-wide health check: if observeBuses hasn't recorded distinct
  // snapshots recently, the upstream pipeline is broken (CTA API outage,
  // cron stall, DB issue). Firing under those conditions would fan a single
  // upstream incident out into a flood of route posts — bail and let the
  // existing detectors' own outage modes handle the alerting.
  const recentSnapshots = countDistinctTsInBusObservations(now - HEALTH_CHECK_WINDOW_MS);
  if (recentSnapshots < MIN_HEALTHY_SNAPSHOTS) {
    console.warn(
      `thin-gaps: only ${recentSnapshots} distinct observation snapshots in past ${HEALTH_CHECK_WINDOW_MS / 60000} min — observation pipeline looks unhealthy, skipping`,
    );
    return;
  }

  const dryRun = !!(argv['dry-run'] || process.env.THIN_GAPS_DRY_RUN);
  let agentPromise = null;
  const getAgent = () => {
    if (!agentPromise) agentPromise = loginBus();
    return agentPromise;
  };

  // Clear pass first: resolve any still-open thin-gap firings whose routes
  // have buses showing up again. Runs before the fire pass so a route that
  // recovered and then immediately re-broke gets its earlier post tidied
  // up rather than left dangling. (24h cooldown prevents the re-fire from
  // landing this same tick anyway.)
  await handleClears(now, getAgent, dryRun);

  const priorHour = new Date(now - HOUR_MS);
  const nextHour = new Date(now + HOUR_MS);
  const drops = [];
  const allEvents = detectThinGaps({
    routes: lowFrequency.filter((r) => index.routes[r]),
    getObservations: (route, since) => getBusObservations(route, since),
    getHeadway: (route) => expectedBusRouteHeadwayMin(route, new Date(now)),
    getActiveTrips: (route) => expectedBusRouteActiveTrips(route, new Date(now)),
    getPriorHourActiveTrips: (route) => expectedBusRouteActiveTrips(route, priorHour),
    getNextHourActiveTrips: (route) => expectedBusRouteActiveTrips(route, nextHour),
    now,
    onDrop: (d) => drops.push(d),
  });

  // Filter out routes already cooled down (one post per day per route).
  const events = allEvents.filter((e) => !isOnCooldown(`thin-gap:${e.route}`, now));
  const cooledDown = allEvents.length - events.length;
  if (cooledDown > 0) {
    console.log(`thin-gaps: ${cooledDown} event(s) suppressed by daily cap`);
  }

  if (events.length === 0) {
    console.log(`No thin-service gaps meet the threshold (drops: ${drops.length})`);
    return;
  }

  for (const e of events) {
    console.log(
      `  Route ${e.route}: no observations in past ${e.windowMin} min (scheduled headway ~${e.headwayMin.toFixed(1)} min, ${e.missedTrips} trips missed)`,
    );
  }

  const posts = buildPostThread(events);
  if (!posts || posts.length === 0) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }

  if (dryRun) {
    for (let i = 0; i < posts.length; i++) {
      console.log(`\n--- DRY RUN post ${i + 1}/${posts.length} ---\n${posts[i].text}`);
    }
    return;
  }

  // Acquire cooldowns up front. If acquireCooldown fails for any route, drop
  // that route from the event list before posting — keeps the post body
  // truthful with what we actually committed to suppress.
  const committed = [];
  for (const e of events) {
    const ok = acquireCooldown(`thin-gap:${e.route}`, now, DAILY_CAP_KEY_TTL_MS);
    if (ok) committed.push(e);
    else console.log(`thin-gaps: lost cooldown race on route ${e.route}, skipping`);
  }
  if (committed.length === 0) {
    console.log('thin-gaps: all events lost cooldown race, nothing to post');
    return;
  }

  // Re-build posts against the committed set in case the cooldown race trimmed
  // some events out.
  const finalPosts = committed.length === events.length ? posts : buildPostThread(committed);

  for (const e of committed) {
    recordMetaSignal({
      kind: 'bus',
      line: e.route,
      direction: null,
      source: 'thin-gap',
      severity: e.severity,
      detail: {
        headwayMin: e.headwayMin,
        windowMin: e.windowMin,
        missedTrips: e.missedTrips,
      },
      posted: true,
    });
  }

  const agent = await getAgent();
  let replyRef = null;
  let eventCursor = 0;
  for (let i = 0; i < finalPosts.length; i++) {
    const result = await postText(agent, finalPosts[i].text, replyRef);
    console.log(`Posted ${i + 1}/${finalPosts.length}: ${result.url}`);
    // Record one disruption_event per route covered by this post so the
    // cta-alert-history export pipeline picks it up. The export-web.js
    // 'observed' / 'observed-held' / 'observed-thin' source union is the
    // only path from server-side detection to the public dashboard.
    const slice = committed.slice(eventCursor, eventCursor + finalPosts[i].lineCount);
    for (const e of slice) {
      // Backdate ts to the last moment a bus was actually seen on this
      // route, not the 20-min cron tick that noticed. Falls back to now if
      // the route has no prior observations (shouldn't happen since the
      // detector requires steady-state service in both adjacent hours).
      const lastSeenTs = getLastBusObservationTs(e.route);
      recordDisruption(
        {
          kind: 'bus',
          line: e.route,
          source: 'observed-thin',
          posted: true,
          postUri: result.uri,
          evidence: {
            headwayMin: e.headwayMin,
            windowMin: e.windowMin,
            missedTrips: e.missedTrips,
          },
        },
        lastSeenTs ?? now,
      );
    }
    eventCursor += finalPosts[i].lineCount;
    if (i < finalPosts.length - 1) replyRef = await resolveReplyRef(agent, result.uri);
  }
}

module.exports = { formatLine, buildPostThread, buildClearText, findUnresolvedThinGaps };

if (require.main === module) {
  runBin(main);
}
