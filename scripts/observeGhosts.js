#!/usr/bin/env node
// Dedicated bus observer for ghost detection. Fetches positions for the
// `ghosts` route list on a fixed cadence so the hourly rollup has consistent
// coverage — independent of bunching/gaps polling. The observation logger
// inside `getVehicles` writes every vehicle to SQLite; this script exists
// purely to trigger that fetch.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getVehicles } = require('../src/bus/api');
const { ghosts: ghostRoutes } = require('../src/bus/routes');
const { rolloffOldObservations } = require('../src/shared/observations');

async function main() {
  rolloffOldObservations();
  if (ghostRoutes.length === 0) {
    console.log('No ghost routes configured, nothing to observe');
    return;
  }
  console.log(`Observing ${ghostRoutes.length} route(s) for ghost detection...`);
  const vehicles = await getVehicles(ghostRoutes);
  console.log(`Recorded ${vehicles.length} vehicle observation(s)`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
