#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { loadBusHeatmap } = require('../../src/shared/heatmap');
const { renderHeatmap } = require('../../src/map');
const { loginBus, postWithImage } = require('../../src/bus/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { buildPostText, buildAltText } = require('../../src/shared/heatmapPost');

const WINDOW_DAYS = { week: 7, month: 30 };
// Noise floor: don't plot locations with fewer than this many incidents in
// the window. Keeps the map legible on low-volume windows.
const MIN_COUNT = { week: 3, month: 3 };
// Cap plotted circles so the citywide view stays legible; the text summary
// still reflects the full count above the floor.
const RENDER_CAP = 40;

async function main() {
  setup();
  const window = argv.window || 'month';
  const days = WINDOW_DAYS[window];
  if (!days) {
    console.error(`Unknown --window: ${window}. Use week or month.`);
    process.exit(1);
  }
  const minCount = MIN_COUNT[window];

  console.log(`Bus heatmap, ${window} (${days}-day window)`);
  const allPoints = loadBusHeatmap(days);
  const points = allPoints.filter((p) => p.count >= minCount);
  const totalIncidents = points.reduce((sum, p) => sum + p.count, 0);

  console.log(`  ${allPoints.length} total spots, ${points.length} above the ${minCount}-incident floor (${totalIncidents} incidents)`);
  for (const p of points.slice(0, 5)) {
    console.log(`  ${p.count}× ${p.label} (bunches=${p.bunching}, gaps=${p.gap})`);
  }

  if (totalIncidents === 0) {
    console.log('No chronic spots this window — nothing to post.');
    return;
  }

  const plotted = [...points].sort((a, b) => b.count - a.count).slice(0, RENDER_CAP);
  const image = await renderHeatmap({ points: plotted, kind: 'bus' });
  const text = buildPostText({ mode: 'bus', window, points, totalIncidents });
  const alt = buildAltText({ mode: 'bus', window, points, totalIncidents });

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(image, `heatmap-bus-${window}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginBus();
  const result = await postWithImage(agent, text, image, alt);
  console.log(`Posted: ${result.url}`);
}

runBin(main);
