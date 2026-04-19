#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const argv = require('minimist')(process.argv.slice(2));

const { LINE_NAMES, LINE_EMOJI, ALL_LINES } = require('../src/trainApi');
const { detectTrainGhosts } = require('../src/trainGhosts');
const { buildRollupPost } = require('../src/ghosts');
const { expectedTrainHeadwayMin, expectedTrainTripMinutes, isTrainLoopLine } = require('../src/shared/gtfs');
const { getTrainObservations, rolloffOldObservations } = require('../src/shared/observations');
const { loginTrain, postText } = require('../src/bluesky');
const trainStations = require('../src/data/trainStations.json');

const WINDOW_MS = 60 * 60 * 1000;

// Mirrors the station lookup used by trainGaps: destination strings don't
// always match trainStations.json verbatim, so try exact → startsWith →
// substring on names filtered to the current line.
function findStationByDestination(line, destination) {
  if (!destination) return null;
  const norm = destination.toLowerCase();
  const candidates = trainStations.filter((s) => s.lines?.includes(line));
  for (const s of candidates) {
    if (s.name.toLowerCase() === norm) return s;
  }
  for (const s of candidates) {
    const baseName = s.name.toLowerCase().split(' (')[0];
    if (baseName === norm || baseName.startsWith(norm) || norm.startsWith(baseName)) return s;
  }
  for (const s of candidates) {
    if (s.name.toLowerCase().includes(norm)) return s;
  }
  return null;
}

function formatLine(event) {
  const lineName = LINE_NAMES[event.line];
  const emoji = LINE_EMOJI[event.line];
  const missing = Math.round(event.missing);
  const expected = Math.round(event.expectedActive);
  const dest = event.destination ? ` → ${event.destination}` : '';
  return `${emoji} ${lineName} Line${dest} · ${missing} of ${expected} missing`;
}

function buildPostText(events) {
  return buildRollupPost('👻 Ghost trains, past hour', events.map(formatLine));
}

async function main() {
  rolloffOldObservations();

  const now = Date.now();
  const sinceTs = now - WINDOW_MS;

  const events = await detectTrainGhosts({
    lines: ALL_LINES,
    getObservations: (line) => getTrainObservations(line, sinceTs),
    findStation: findStationByDestination,
    expectedHeadway: (line, destStation) => expectedTrainHeadwayMin(line, destStation, new Date(now)),
    expectedDuration: (line, destStation) => expectedTrainTripMinutes(line, destStation, new Date(now)),
    isLoopLine: isTrainLoopLine,
  });

  if (events.length === 0) {
    console.log('No ghost train events meet the threshold, staying silent');
    return;
  }

  for (const e of events) {
    const dirLabel = e.trDr ? `${e.trDr} (${e.destination || '?'})` : '(line-wide)';
    console.log(`  ${LINE_NAMES[e.line]} ${dirLabel}: ${e.observedActive.toFixed(1)} observed vs ${e.expectedActive.toFixed(1)} expected (${e.missing.toFixed(1)} missing across ${e.snapshots} snapshots)`);
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

  const agent = await loginTrain();
  const result = await postText(agent, text);
  console.log(`Posted: ${result.url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
