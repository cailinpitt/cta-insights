#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { loadBusHeatmap, loadGapLeaderboard, rangeForWindow } = require('../../src/shared/recap');
const { renderHeatmap, renderGapChart } = require('../../src/map');
const { loginBus, postWithImage } = require('../../src/bus/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const {
  buildPostText, buildAltText,
  buildGapReplyText, buildGapReplyAlt,
} = require('../../src/shared/recapPost');

const GAP_CHART_CAP = 10;
const MIN_COUNT = { week: 3, month: 3 };
const RENDER_CAP = 40;

// Numeric routes first by number, then letter-prefixed (X9, J14, etc.).
function formatBusRoutes(routes) {
  if (!routes || routes.length === 0) return '';
  const sorted = [...routes].sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb || a.localeCompare(b);
    if (Number.isFinite(na)) return -1;
    if (Number.isFinite(nb)) return 1;
    return a.localeCompare(b);
  });
  const prefix = sorted.length === 1 ? 'Route' : 'Routes';
  return `${prefix} ${sorted.join(', ')}`;
}

const formatBusRoute = (r) => `Route ${r}`;

async function main() {
  setup();
  const window = argv.window || 'month';
  if (!(window in MIN_COUNT)) {
    console.error(`Unknown --window: ${window}. Use week or month.`);
    process.exit(1);
  }
  const minCount = MIN_COUNT[window];
  const { since, until, label: windowLabel } = rangeForWindow(window);

  console.log(`Bus recap, ${window} (${windowLabel})`);
  const allPoints = loadBusHeatmap(since, until);
  const points = allPoints
    .filter((p) => p.count >= minCount)
    .map((p) => ({ ...p, routesLabel: formatBusRoutes(p.routes) }));
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
  const text = buildPostText({ mode: 'bus', window, windowLabel, points, totalIncidents });
  const alt = buildAltText({ mode: 'bus', window, windowLabel, points, totalIncidents });

  const gapEntriesAll = loadGapLeaderboard('bus', since, until);
  const totalGaps = gapEntriesAll.reduce((s, e) => s + e.count, 0);
  const gapEntries = gapEntriesAll.slice(0, GAP_CHART_CAP);
  const hasGapReply = totalGaps > 0 && gapEntries.length > 0;

  let gapImage = null;
  let gapText = '';
  let gapAlt = '';
  if (hasGapReply) {
    gapImage = await renderGapChart({ kind: 'bus', entries: gapEntries, window, windowLabel, totalGaps, formatRoute: formatBusRoute });
    gapText = buildGapReplyText({ mode: 'bus', window, windowLabel, entries: gapEntries, totalGaps, routeCount: gapEntriesAll.length, formatRoute: formatBusRoute });
    gapAlt = buildGapReplyAlt({ mode: 'bus', window, windowLabel, entries: gapEntries, totalGaps, formatRoute: formatBusRoute });
  }

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(image, `heatmap-bus-${window}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    if (hasGapReply) {
      const gapPath = writeDryRunAsset(gapImage, `gapchart-bus-${window}-${Date.now()}.jpg`);
      console.log(`\n--- DRY RUN (gap reply) ---\n${gapText}\n\nAlt: ${gapAlt}\nImage: ${gapPath}`);
    } else {
      console.log('\n(no gap reply — no gaps in window)');
    }
    return;
  }

  const agent = await loginBus();
  const primary = await postWithImage(agent, text, image, alt);
  console.log(`Posted: ${primary.url}`);

  if (hasGapReply) {
    const replyRef = {
      root: { uri: primary.uri, cid: primary.cid },
      parent: { uri: primary.uri, cid: primary.cid },
    };
    const reply = await postWithImage(agent, gapText, gapImage, gapAlt, replyRef);
    console.log(`Gap reply: ${reply.url}`);
  }
}

runBin(main);
