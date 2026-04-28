#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { names: routeNames, ghosts: ghostRoutes, allRoutes } = require('../../src/bus/routes');
const { detectBusGhosts } = require('../../src/bus/ghosts');
const { buildRollupPost } = require('../../src/shared/post');
const { loadPattern } = require('../../src/bus/patterns');
const {
  expectedHeadwayMin,
  expectedTripMinutes,
  expectedActiveTrips,
  loadIndex,
} = require('../../src/shared/gtfs');
const { getBusObservations, rolloffOldObservations } = require('../../src/shared/observations');
const { loginBus, postText } = require('../../src/bus/bluesky');
const { runBin } = require('../../src/shared/runBin');
const { logDropSummary } = require('../../src/shared/ghostsLog');

const WINDOW_MS = 60 * 60 * 1000;

function abbreviateDirection(dir) {
  if (!dir) return '';
  const m = dir.match(/(North|South|East|West)bound/i);
  if (m) return `${m[1][0].toUpperCase()}B`;
  return dir;
}

function formatLine(event) {
  const name = routeNames[event.route];
  const title = name ? `Route ${event.route} (${name})` : `Route ${event.route}`;
  const dir = abbreviateDirection(event.direction);
  const missing = Math.round(event.missing);
  const expected = Math.round(event.expectedActive);
  const pct = Math.round((event.missing / event.expectedActive) * 100);
  // Headway can be null mid-route-coverage hours; shorter sentence then.
  if (event.headway == null) {
    return `🚌 ${title} ${dir} · ${missing} of ${expected} missing (${pct}%)`;
  }
  const scheduledHeadway = Math.round(event.headway);
  // Above 3× scheduled, the effective-headway display explodes into noise —
  // fall back to "scheduled every ~X min".
  const ratio = event.expectedActive / Math.max(event.observedActive, 1);
  if (ratio > 3) {
    return `🚌 ${title} ${dir} · ${missing} of ${expected} missing (${pct}%) · scheduled every ~${scheduledHeadway} min`;
  }
  const effectiveHeadway = Math.round(event.headway * ratio);
  return `🚌 ${title} ${dir} · ${missing} of ${expected} missing (${pct}%) · every ~${effectiveHeadway} min instead of ~${scheduledHeadway}`;
}

function buildPostText(events) {
  return buildRollupPost('👻 Ghost buses, past hour', events.map(formatLine));
}

async function main() {
  rolloffOldObservations();

  const index = loadIndex();
  // Shadow phase: detect across every route, but only post events for the
  // curated `ghostRoutes` list. Lets us compare what a wider rollout would
  // surface without flipping false positives live. Drop after a clean week.
  const ghostRouteSet = new Set(ghostRoutes);

  const now = Date.now();
  const sinceTs = now - WINDOW_MS;
  // Only warn about missing index entries for routes we actually saw run in
  // the window. CTA's GTFS feed omits Night Owl (N*) and seasonal/special
  // routes entirely (10, 19, 128, 130, …) — those are expected absences,
  // re-running fetch-gtfs won't help, and the noise drowns out real misses.
  const unindexed = allRoutes.filter(
    (r) => !index.routes[r] && getBusObservations(r, sinceTs).length > 0,
  );
  if (unindexed.length) {
    console.warn(
      `Routes missing from GTFS index but actively observed (will be skipped): ${unindexed.join(', ')} — re-run scripts/fetch-gtfs.js`,
    );
  }
  // Schedule lookup at the window midpoint — the 60-min window mostly covers
  // the prior wall-clock hour, so `now` would mis-bucket at rush-hour transitions.
  const lookupAt = new Date(now - WINDOW_MS / 2);

  const drops = [];
  const allEvents = await detectBusGhosts({
    routes: allRoutes,
    getObservations: (route) => getBusObservations(route, sinceTs),
    getPattern: (pid) => loadPattern(pid),
    expectedHeadway: (route, pattern) => expectedHeadwayMin(route, pattern, lookupAt),
    expectedDuration: (route, pattern) => expectedTripMinutes(route, pattern, lookupAt),
    expectedActive: (route, pattern) => expectedActiveTrips(route, pattern, lookupAt),
    onDrop: (d) => drops.push(d),
  });

  const events = allEvents.filter((e) => ghostRouteSet.has(e.route));
  const shadow = allEvents.filter((e) => !ghostRouteSet.has(e.route));

  if (shadow.length > 0) {
    console.log(`Shadow events (would-fire on routes outside curated list): ${shadow.length}`);
    for (const e of shadow) {
      console.log(
        `  [shadow] Route ${e.route} ${e.direction}: ${e.observedActive.toFixed(1)} observed vs ${e.expectedActive.toFixed(1)} expected (${e.missing.toFixed(1)} missing across ${e.snapshots} snapshots)`,
      );
    }
  }

  if (events.length === 0) {
    console.log('No ghost bus events meet the threshold, staying silent');
    logDropSummary(drops, 'bus');
    return;
  }

  for (const e of events) {
    console.log(
      `  Route ${e.route} ${e.direction}: ${e.observedActive.toFixed(1)} observed vs ${e.expectedActive.toFixed(1)} expected (${e.missing.toFixed(1)} missing across ${e.snapshots} snapshots)`,
    );
  }

  const text = buildPostText(events);
  if (!text) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }

  if (argv['dry-run'] || process.env.GHOSTS_DRY_RUN) {
    console.log(`\n--- DRY RUN ---\n${text}`);
    return;
  }

  const agent = await loginBus();
  const result = await postText(agent, text);
  console.log(`Posted: ${result.url}`);
}

module.exports = { formatLine };

if (require.main === module) {
  runBin(main);
}
