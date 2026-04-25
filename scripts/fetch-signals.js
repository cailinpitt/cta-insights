#!/usr/bin/env node
// Monthly OSM Overpass fetch of traffic_signals nodes. Exits nonzero if every
// mirror fails so cron surfaces it.

const Fs = require('fs-extra');
const Path = require('path');
const axios = require('axios');

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const BBOX = { minLat: 41.60, maxLat: 42.10, minLon: -87.95, maxLon: -87.50 };
const OUT_PATH = Path.join(__dirname, '..', 'data', 'signals', 'chicago.json');

async function main() {
  // Pull both highway= and crossing= tagging — many Chicago intersections
  // only have the crossing-style tags. Render-time dedupe handles overlap.
  const bbox = `${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon}`;
  const q = `[out:json][timeout:120];(node["highway"="traffic_signals"](${bbox});node["crossing"="traffic_signals"](${bbox}););out;`;

  for (const url of OVERPASS_URLS) {
    console.log(`Trying ${url}...`);
    try {
      const { data } = await axios.post(url, `data=${encodeURIComponent(q)}`, {
        timeout: 180000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (data.remark) throw new Error(`Overpass remark: ${data.remark}`);
      const signals = (data.elements || []).map((el) => ({ lat: el.lat, lon: el.lon }));
      // Below 1000 signals likely means a silently rate-limited / partial
      // response — try the next mirror rather than clobbering the cache.
      if (signals.length < 1000) throw new Error(`Suspiciously low count: ${signals.length}`);
      Fs.ensureDirSync(Path.dirname(OUT_PATH));
      Fs.writeJsonSync(OUT_PATH, signals);
      console.log(`Wrote ${signals.length} signals to ${OUT_PATH}`);
      return;
    } catch (err) {
      console.warn(`  ${err.message}`);
    }
  }
  console.error('All Overpass mirrors failed');
  process.exit(1);
}

main();
