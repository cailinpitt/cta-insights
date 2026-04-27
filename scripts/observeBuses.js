#!/usr/bin/env node
// Dedicated bus observer — keeps coverage consistent for ghost detection AND
// bus pulse, independent of when bunching/gaps happen to poll. Polls every
// active CTA bus route so both detectors see the full system every tick.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const { getVehicles } = require('../src/bus/api');
const { pulse: pulseRoutes } = require('../src/bus/routes');
const { rolloffOldObservations } = require('../src/shared/observations');

async function main() {
  rolloffOldObservations();
  if (pulseRoutes.length === 0) {
    console.log('No bus routes configured, nothing to observe');
    return;
  }
  console.log(`Observing ${pulseRoutes.length} bus route(s)...`);
  const vehicles = await getVehicles(pulseRoutes);
  console.log(`Recorded ${vehicles.length} vehicle observation(s)`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
