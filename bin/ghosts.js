#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const argv = require('minimist')(process.argv.slice(2));

const { names: routeNames, ghosts: ghostRoutes } = require('../src/routes');
const { detectBusGhosts, buildRollupPost } = require('../src/ghosts');
const { loadPattern } = require('../src/patterns');
const { expectedHeadwayMin, expectedTripMinutes } = require('../src/shared/gtfs');
const { getBusObservations, rolloffOldObservations } = require('../src/shared/observations');
const { loginBus, postText } = require('../src/bluesky');

const WINDOW_MS = 60 * 60 * 1000;

// "Northbound" → "NB", etc. Used in the rollup to keep each line compact.
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
  return `🚌 ${title} ${dir} · ${missing} of ${expected} missing`;
}

function buildPostText(events) {
  return buildRollupPost('👻 Ghost buses, past hour', events.map(formatLine));
}

async function main() {
  rolloffOldObservations();

  const now = Date.now();
  const sinceTs = now - WINDOW_MS;

  const events = await detectBusGhosts({
    routes: ghostRoutes,
    getObservations: (route) => getBusObservations(route, sinceTs),
    getPattern: (pid) => loadPattern(pid),
    expectedHeadway: (route, pattern) => expectedHeadwayMin(route, pattern, new Date(now)),
    expectedDuration: (route, pattern) => expectedTripMinutes(route, pattern, new Date(now)),
  });

  if (events.length === 0) {
    console.log('No ghost bus events meet the threshold, staying silent');
    return;
  }

  for (const e of events) {
    console.log(`  Route ${e.route} ${e.direction}: ${e.observedActive.toFixed(1)} observed vs ${e.expectedActive.toFixed(1)} expected (${e.missing.toFixed(1)} missing across ${e.snapshots} snapshots)`);
  }

  const text = buildPostText(events);
  if (!text) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }

  if (argv['dry-run']) {
    console.log(`\n--- DRY RUN ---\n${text}`);
    return;
  }

  const agent = await loginBus();
  const result = await postText(agent, text);
  console.log(`Posted: ${result.url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
