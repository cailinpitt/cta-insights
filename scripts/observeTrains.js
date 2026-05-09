#!/usr/bin/env node
// Densifies train-observations capture by polling Train Tracker every 30s.
// Cron's minimum granularity is 1 minute, so this script runs two ticks 30s
// apart per cron firing. recordTrainObservations is invoked by
// getAllTrainPositions; this script's only job is to call it on its own
// cadence so detection cron jobs aren't the only writers to the observations
// table.

require('../src/shared/env');

const { setup, runBin } = require('../src/shared/runBin');
const { getAllTrainPositions } = require('../src/train/api');

const TICK_INTERVAL_MS = 30 * 1000;
const TICKS_PER_RUN = 2;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultTick() {
  try {
    const trains = await getAllTrainPositions();
    console.log(`observe-trains: recorded ${trains.length} trains`);
  } catch (e) {
    console.warn(`observe-trains: getAllTrainPositions failed: ${e.message}`);
  }
}

// Exposed for testing — deps injected so the test can assert call count and
// inter-tick spacing without sleeping for real.
async function runTicks({
  tick = defaultTick,
  sleep = defaultSleep,
  ticksPerRun = TICKS_PER_RUN,
  intervalMs = TICK_INTERVAL_MS,
} = {}) {
  for (let i = 0; i < ticksPerRun; i++) {
    if (i > 0) await sleep(intervalMs);
    await tick();
  }
}

async function main() {
  setup();
  await runTicks();
}

if (require.main === module) {
  runBin(main);
}

module.exports = { runTicks, TICK_INTERVAL_MS, TICKS_PER_RUN };
