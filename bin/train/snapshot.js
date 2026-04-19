#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS } = require('../../src/train/api');
const { renderSnapshot } = require('../../src/map');
const trainLines = require('../../src/train/data/trainLines.json');
const { loginTrain, postWithImage } = require('../../src/train/bluesky');
const { pruneOldAssets } = require('../../src/shared/cleanup');
const { buildPostText, buildAltText } = require('../../src/train/snapshot');

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
  const result = await postWithImage(agent, text, image, alt);
  console.log(`Posted: ${result.url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
