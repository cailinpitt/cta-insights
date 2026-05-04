#!/usr/bin/env node
// One-off: render a bus blackout disruption image for visual inspection.
// Picks the longest known pattern for the given route and writes a JPEG.
//
// Usage: node scripts/render-disruption-once.js --route=53A --out=/tmp/53A.jpg

require('../src/shared/env');
const Fs = require('fs-extra');
const minimist = require('minimist');
const { renderBusDisruptionRich } = require('../src/map/bus/disruption');
const { loadPattern } = require('../src/bus/patterns');
const { getDb } = require('../src/shared/history');

const argv = minimist(process.argv.slice(2));
const route = argv.route;
const out = argv.out;
const titleArg = argv.title;
if (!route || !out) {
  console.error('--route and --out required');
  process.exit(1);
}

(async () => {
  const sinceTs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT direction AS pid FROM observations
       WHERE kind = 'bus' AND route = ? AND ts >= ? AND direction IS NOT NULL`,
    )
    .all(String(route), sinceTs);
  const pids = rows.map((r) => r.pid);
  if (pids.length === 0) {
    console.error(`no recent pids for route ${route}`);
    process.exit(2);
  }
  let canonical = null;
  for (const pid of pids) {
    try {
      const p = await loadPattern(pid);
      if (p && (!canonical || (p.points?.length || 0) > (canonical.points?.length || 0))) {
        canonical = p;
      }
    } catch (_e) {}
  }
  if (!canonical) {
    console.error('no canonical pattern resolved');
    process.exit(3);
  }
  const title = titleArg || `⚠ #${route} South Pulaski service appears suspended`;
  const buf = await renderBusDisruptionRich({
    route,
    pattern: canonical,
    focusZone: null,
    title,
    mode: 'blackout',
  });
  if (!buf) {
    console.error('renderer returned null');
    process.exit(4);
  }
  Fs.writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes)`);
})().catch((e) => {
  console.error(e);
  process.exit(99);
});
