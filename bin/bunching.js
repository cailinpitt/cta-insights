#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getVehicles } = require('../src/cta');
const routeNames = require('../src/routes');
const { detectBunching } = require('../src/bunching');
const { loadPattern } = require('../src/patterns');
const { renderBunchingMap } = require('../src/map');
const { login, postWithImage } = require('../src/bluesky');
const { isOnCooldown, markPosted } = require('../src/state');

function findNearestStop(pattern, pdist) {
  const stops = pattern.points.filter((p) => p.type === 'S' && p.stopName);
  let best = stops[0];
  let bestDelta = Math.abs(stops[0].pdist - pdist);
  for (const s of stops) {
    const delta = Math.abs(s.pdist - pdist);
    if (delta < bestDelta) {
      best = s;
      bestDelta = delta;
    }
  }
  return best;
}

function formatDistance(ft) {
  if (ft < 1000) return `${ft} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function buildPostText(bunch, pattern, stop) {
  const name = `${bunch.route} ${routeNames[bunch.route] || ''}`.trim();
  const count = bunch.vehicles.length;
  const dir = pattern.direction;
  const gap = formatDistance(bunch.spanFt);
  return `🚌 ${name} is bunched\n${count} ${dir} buses within ${gap} near ${stop.stopName}`;
}

function buildAltText(bunch, pattern, stop) {
  const name = `${bunch.route} ${routeNames[bunch.route] || ''}`.trim();
  return `Map of ${name} bus route near ${stop.stopName} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses clustered within ${formatDistance(bunch.spanFt)} of each other.`;
}

async function main() {
  const routes = Object.keys(routeNames);
  console.log(`Fetching vehicles for ${routes.length} routes...`);
  const vehicles = await getVehicles(routes);
  console.log(`Got ${vehicles.length} vehicles`);

  const bunch = detectBunching(vehicles);
  if (!bunch) {
    console.log('No bunching detected');
    return;
  }

  console.log(`Bunching: route ${bunch.route} pid ${bunch.pid} — ${bunch.vehicles.length} buses, span ${bunch.spanFt} ft`);
  console.log(`  vids: ${bunch.vehicles.map((v) => v.vid).join(', ')}`);

  if (!argv['dry-run'] && isOnCooldown(bunch.pid)) {
    console.log(`On cooldown for pid ${bunch.pid}, skipping`);
    return;
  }

  const pattern = await loadPattern(bunch.pid);
  const midPdist = (bunch.vehicles[0].pdist + bunch.vehicles[bunch.vehicles.length - 1].pdist) / 2;
  const stop = findNearestStop(pattern, midPdist);

  console.log('Rendering map...');
  const image = await renderBunchingMap(bunch, pattern);

  const text = buildPostText(bunch, pattern, stop);
  const alt = buildAltText(bunch, pattern, stop);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `bunching-${bunch.pid}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await login();
  const url = await postWithImage(agent, text, image, alt);
  markPosted(bunch.pid);
  console.log(`Posted: ${url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
