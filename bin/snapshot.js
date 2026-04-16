#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS, LINE_NAMES, ALL_LINES } = require('../src/trainApi');
const { renderSnapshot } = require('../src/map');
const trainLines = require('../src/data/trainLines.json');
const trainStations = require('../src/data/trainStations.json');
const { loginTrain, postWithImage } = require('../src/bluesky');
const { pruneOldAssets } = require('../src/cleanup');

function formatTimeCT(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago',
  });
}

function buildPostText(trains, now) {
  const total = trains.length;
  const byLine = new Map();
  for (const t of trains) byLine.set(t.line, (byLine.get(t.line) || 0) + 1);

  // Break down by line in canonical order, showing 0 for inactive lines.
  const parts = ALL_LINES
    .map((l) => `${LINE_NAMES[l]} ${byLine.get(l) || 0}`);

  return `🚆 CTA L right now\n${formatTimeCT(now)} CT · ${total} trains system-wide\n\n${parts.join(' · ')}`;
}

function buildAltText(trains) {
  const byLine = new Map();
  for (const t of trains) byLine.set(t.line, (byLine.get(t.line) || 0) + 1);
  const summary = ALL_LINES
    .map((l) => `${byLine.get(l) || 0} ${LINE_NAMES[l]}`)
    .join(', ');
  return `Map of Chicago showing live positions of ${trains.length} CTA L trains currently in service, colored by line: ${summary}.`;
}

async function main() {
  pruneOldAssets();

  console.log('Fetching train positions for all 8 lines...');
  const trains = await getAllTrainPositions();
  if (trains.length === 0) {
    console.log('No trains in service — nothing to post');
    return;
  }
  console.log(`Got ${trains.length} trains`);

  const now = new Date();
  // Skip stations on system snapshot — they blow the Mapbox URL limit when
  // combined with 70+ train pins. Station markers are still used on the
  // zoomed-in bunching map where only nearby stations are included.
  const image = await renderSnapshot(trains, LINE_COLORS, trainLines);
  const text = buildPostText(trains, now);
  const alt = buildAltText(trains);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `snapshot-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginTrain();
  const url = await postWithImage(agent, text, image, alt);
  console.log(`Posted: ${url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
