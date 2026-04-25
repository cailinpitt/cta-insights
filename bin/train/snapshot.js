#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS } = require('../../src/train/api');
const trainLines = require('../../src/train/data/trainLines.json');
const { loginTrain, postWithVideo } = require('../../src/train/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { buildVideoPostText, buildVideoAltText } = require('../../src/train/snapshot');
const { captureSnapshotVideo } = require('../../src/train/snapshotVideo');

async function main() {
  setup();

  const ticks = argv.ticks ? parseInt(argv.ticks, 10) : undefined;
  const tickMs = argv['tick-ms'] ? parseInt(argv['tick-ms'], 10) : undefined;
  const interpolate = argv.interpolate ? parseInt(argv.interpolate, 10) : undefined;

  console.log('Fetching initial train positions...');
  const initialTrains = await getAllTrainPositions();
  if (initialTrains.length === 0) {
    console.log('No trains in service — nothing to post');
    return;
  }
  console.log(`Got ${initialTrains.length} trains; capturing timelapse...`);

  const result = await captureSnapshotVideo(initialTrains, LINE_COLORS, trainLines, {
    ticks,
    tickMs,
    interpolate,
  });
  if (!result) {
    console.log('Snapshot video capture produced <2 frames, aborting');
    return;
  }
  const windowMin = Math.round(result.elapsedSec / 60);
  const finalTrains = result.finalTrains;
  const text = buildVideoPostText(
    finalTrains,
    new Date(result.startTs),
    new Date(result.endTs),
    windowMin,
    result.initialTrains,
  );
  const alt = buildVideoAltText(finalTrains, windowMin);

  console.log(
    `Captured ${result.ticksCaptured} ticks over ${result.elapsedSec}s (${(result.buffer.length / 1024 / 1024).toFixed(1)} MB)`,
  );

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(result.buffer, `snapshot-${Date.now()}.mp4`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nVideo: ${outPath}`);
    return;
  }

  const agent = await loginTrain();
  const post = await postWithVideo(agent, text, result.buffer, alt);
  console.log(`Posted: ${post.url}`);
}

runBin(main);
