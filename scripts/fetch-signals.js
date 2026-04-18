#!/usr/bin/env node
// Fetches every OSM traffic_signals node across the CTA service area and
// writes data/signals/chicago.json. Run periodically (monthly is plenty —
// signals rarely move). Exits non-zero if every mirror fails so cron surfaces it.

const Fs = require('fs-extra');
const Path = require('path');
const axios = require('axios');

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const BBOX = { minLat: 41.60, maxLat: 42.10, minLon: -87.95, maxLon: -87.50 };
const OUT_PATH = Path.join(__dirname, '..', 'data', 'signals', 'chicago.json');

async function main() {
  // Two OSM tagging conventions for signalized intersections: a standalone
  // `highway=traffic_signals` node, or `crossing=traffic_signals` on each
  // pedestrian crossing node. Many Chicago intersections (e.g. Irving Park
  // & Kostner) only have the crossing-style tags, so we pull both. Dedupe
  // at render time collapses the multiple crossing nodes per intersection.
  const bbox = `${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon}`;
  const q = `[out:json][timeout:120];(node["highway"="traffic_signals"](${bbox});node["crossing"="traffic_signals"](${bbox}););out;`;

  for (const url of OVERPASS_URLS) {
    console.log(`Trying ${url}...`);
    try {
      const { data } = await axios.post(url, `data=${encodeURIComponent(q)}`, {
        timeout: 180000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const signals = (data.elements || []).map((el) => ({ lat: el.lat, lon: el.lon }));
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
