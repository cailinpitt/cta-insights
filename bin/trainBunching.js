#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS, LINE_NAMES } = require('../src/trainApi');
const { detectTrainBunching } = require('../src/trainBunching');
const { renderTrainBunching } = require('../src/map');
const { loginTrain, postWithImage } = require('../src/bluesky');
const { isOnCooldown, markPosted } = require('../src/state');
const { pruneOldAssets } = require('../src/cleanup');
const trainLines = require('../src/data/trainLines.json');
const trainStations = require('../src/data/trainStations.json');

function formatDistance(ft) {
  if (ft < 1000) return `${Math.round(ft)} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function buildPostText(bunch) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = bunch.trains[0].nextStation;
  return `🚆 ${lineName} Line bunched\n2 trains to ${dest} within ${formatDistance(bunch.distanceFt)} near ${station}`;
}

function buildAltText(bunch) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = bunch.trains[0].nextStation;
  return `Map showing two ${lineName} Line trains bound for ${dest} clustered within ${formatDistance(bunch.distanceFt)} of each other near ${station}.`;
}

async function main() {
  pruneOldAssets();

  console.log('Fetching train positions...');
  const trains = await getAllTrainPositions();
  console.log(`Got ${trains.length} trains`);

  const bunch = detectTrainBunching(trains);
  if (!bunch) {
    console.log('No train bunching detected');
    return;
  }

  console.log(`Bunching: ${bunch.line} trDr=${bunch.trDr} — 2 trains ${Math.round(bunch.distanceFt)}ft apart`);
  console.log(`  rns: ${bunch.trains.map((t) => t.rn).join(', ')}`);

  // Cooldown keyed by line+direction so a persistent bunch on one direction
  // of one line doesn't post repeatedly while still allowing the opposite
  // direction to post if it happens to also bunch.
  const cooldownKey = `train_${bunch.line}_${bunch.trDr}`;
  if (!argv['dry-run'] && isOnCooldown(cooldownKey)) {
    console.log(`On cooldown for ${cooldownKey}, skipping`);
    return;
  }

  console.log('Rendering map...');
  const image = await renderTrainBunching(bunch, LINE_COLORS, trainLines, trainStations);
  const text = buildPostText(bunch);
  const alt = buildAltText(bunch);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `train-bunching-${bunch.line}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginTrain();
  const url = await postWithImage(agent, text, image, alt);
  markPosted(cooldownKey);
  console.log(`Posted: ${url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
