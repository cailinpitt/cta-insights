#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { names: routeNames, lowFrequency } = require('../../src/bus/routes');
const { detectThinGaps } = require('../../src/bus/thinGaps');
const { getBusObservations } = require('../../src/shared/observations');
const {
  expectedBusRouteHeadwayMin,
  expectedBusRouteActiveTrips,
  loadIndex,
} = require('../../src/shared/gtfs');
const { recordMetaSignal } = require('../../src/shared/history');
const { acquireCooldown, isOnCooldown } = require('../../src/shared/state');
const { loginBus, postText } = require('../../src/bus/bluesky');
const { buildRollupThread } = require('../../src/shared/post');
const { resolveReplyRef } = require('../../src/shared/bluesky');
const { setup, runBin } = require('../../src/shared/runBin');

// Daily cap mirrors the bus-gap channel — thin-gap posts share the same thread
// space and a single chronically-down route shouldn't dominate the feed.
const DAILY_CAP_KEY_TTL_MS = 24 * 60 * 60 * 1000;

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
  const drops = [];
  const allEvents = detectThinGaps({
    routes: lowFrequency.filter((r) => index.routes[r]),
    getObservations: (route, since) => getBusObservations(route, since),
    getHeadway: (route) => expectedBusRouteHeadwayMin(route, new Date(now)),
    getActiveTrips: (route) => expectedBusRouteActiveTrips(route, new Date(now)),
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

  if (argv['dry-run'] || process.env.THIN_GAPS_DRY_RUN) {
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

  const agent = await loginBus();
  let replyRef = null;
  for (let i = 0; i < finalPosts.length; i++) {
    const result = await postText(agent, finalPosts[i].text, replyRef);
    console.log(`Posted ${i + 1}/${finalPosts.length}: ${result.url}`);
    if (i < finalPosts.length - 1) replyRef = await resolveReplyRef(agent, result.uri);
  }
}

module.exports = { formatLine, buildPostThread };

if (require.main === module) {
  runBin(main);
}
