#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { LINE_COLORS, LINE_NAMES } = require('../../src/train/api');
const { loadTrainHeatmap, loadGapLeaderboard } = require('../../src/shared/heatmap');
const { renderHeatmap, renderGapChart } = require('../../src/map');
const { loginTrain, postWithImage } = require('../../src/train/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const {
  buildPostText, buildAltText,
  buildGapReplyText, buildGapReplyAlt,
} = require('../../src/shared/heatmapPost');
const trainLines = require('../../src/train/data/trainLines.json');

const WINDOW_DAYS = { week: 7, month: 30 };
const MIN_COUNT = { week: 3, month: 3 };
const RENDER_CAP = 40;

// Canonical line order so "Red, Brown, Purple" reads the same way every time
// regardless of which event happened to land in the bucket first.
const LINE_ORDER = ['red', 'blue', 'brn', 'g', 'org', 'p', 'pink', 'y'];
const LINE_NAME_SET = new Set(Object.values(LINE_NAMES));
// Strip a trailing " (Red/Brown/Purple)"-style line-list from a station label
// so it doesn't duplicate the routes shown after the em-dash. Leaves richer
// parentheticals like "Harlem (Blue - O'Hare Branch)" intact since stripping
// those would collide "Harlem (Blue - Forest Park Branch)" into the same label.
function stripLineParens(label) {
  const m = label.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  if (!m) return label;
  const tokens = m[2].split('/').map((t) => t.trim());
  return tokens.every((t) => LINE_NAME_SET.has(t)) ? m[1] : label;
}

function formatTrainLines(routes) {
  if (!routes || routes.length === 0) return '';
  return [...routes]
    .sort((a, b) => LINE_ORDER.indexOf(a) - LINE_ORDER.indexOf(b))
    .map((r) => LINE_NAMES[r] || r)
    .join(', ');
}

async function main() {
  setup();
  const window = argv.window || 'month';
  const days = WINDOW_DAYS[window];
  if (!days) {
    console.error(`Unknown --window: ${window}. Use week or month.`);
    process.exit(1);
  }
  const minCount = MIN_COUNT[window];

  console.log(`Train heatmap, ${window} (${days}-day window)`);
  const allPoints = loadTrainHeatmap(days);
  const points = allPoints
    .filter((p) => p.count >= minCount)
    .map((p) => ({
      ...p,
      label: stripLineParens(p.label),
      routesLabel: formatTrainLines(p.routes),
    }));
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
  const image = await renderHeatmap({ points: plotted, kind: 'train', trainLines, lineColors: LINE_COLORS });
  const text = buildPostText({ mode: 'train', window, points, totalIncidents });
  const alt = buildAltText({ mode: 'train', window, points, totalIncidents });

  // Show every line in canonical order — even zero-gap lines — so the chart
  // conveys the whole system picture rather than just the worst offenders.
  const gapCounts = new Map(loadGapLeaderboard('train', days).map((e) => [e.route, e.count]));
  const gapEntries = LINE_ORDER.map((line) => ({ route: line, count: gapCounts.get(line) || 0 }));
  const totalGaps = gapEntries.reduce((s, e) => s + e.count, 0);
  const rankedGapEntries = [...gapEntries].sort((a, b) => b.count - a.count);
  const formatTrainRoute = (r) => LINE_NAMES[r] || r;
  const hasGapReply = totalGaps > 0;

  let gapImage = null;
  let gapText = '';
  let gapAlt = '';
  if (hasGapReply) {
    gapImage = await renderGapChart({
      kind: 'train', entries: rankedGapEntries, window, totalGaps,
      lineNames: LINE_NAMES, lineColors: LINE_COLORS,
    });
    gapText = buildGapReplyText({ mode: 'train', window, entries: rankedGapEntries, totalGaps, formatRoute: formatTrainRoute });
    gapAlt = buildGapReplyAlt({ mode: 'train', window, entries: rankedGapEntries, totalGaps, formatRoute: formatTrainRoute });
  }

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(image, `heatmap-train-${window}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    if (hasGapReply) {
      const gapPath = writeDryRunAsset(gapImage, `gapchart-train-${window}-${Date.now()}.jpg`);
      console.log(`\n--- DRY RUN (gap reply) ---\n${gapText}\n\nAlt: ${gapAlt}\nImage: ${gapPath}`);
    } else {
      console.log('\n(no gap reply — no gaps in window)');
    }
    return;
  }

  const agent = await loginTrain();
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
