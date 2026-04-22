#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { names: routeNames, ghosts: ghostRoutes } = require('../../src/bus/routes');
const { detectBusGhosts } = require('../../src/bus/ghosts');
const { buildRollupPost } = require('../../src/shared/post');
const { loadPattern } = require('../../src/bus/patterns');
const { expectedHeadwayMin, expectedTripMinutes, loadIndex } = require('../../src/shared/gtfs');
const { getBusObservations, rolloffOldObservations } = require('../../src/shared/observations');
const { loginBus, postText } = require('../../src/bus/bluesky');
const { runBin } = require('../../src/shared/runBin');

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
  const pct = Math.round((event.missing / event.expectedActive) * 100);
  const scheduledHeadway = Math.round(event.headway);
  // When observed drops near zero, the effective-headway estimate explodes and
  // looks like noise ("every ~180 min instead of ~10"). Above 3× the scheduled
  // headway the number stops telling readers anything useful, so fall back to
  // "scheduled every ~X min".
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
  const unindexed = ghostRoutes.filter((r) => !index.routes[r]);
  if (unindexed.length) {
    console.warn(`Routes missing from GTFS index (will be skipped): ${unindexed.join(', ')} — re-run scripts/fetch-gtfs.js`);
  }

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
