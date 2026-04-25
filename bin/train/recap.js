#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { LINE_COLORS, LINE_NAMES } = require('../../src/train/api');
const { loadTrainHeatmap, loadGapLeaderboard, rangeForWindow } = require('../../src/shared/recap');
const { renderHeatmap, renderGapChart } = require('../../src/map');
const { loginTrain, postWithImage } = require('../../src/train/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const {
  buildPostText, buildAltText,
  buildGapReplyText, buildGapReplyAlt,
} = require('../../src/shared/recapPost');
const trainLines = require('../../src/train/data/trainLines.json');

const MIN_COUNT = { week: 3, month: 3 };
const RENDER_CAP = 40;

const LINE_ORDER = ['red', 'blue', 'brn', 'g', 'org', 'p', 'pink', 'y'];
const LINE_NAME_SET = new Set(Object.values(LINE_NAMES));
// Drops trailing " (Red/Brown)" from station labels — but leaves richer
// parentheticals like "Harlem (Blue - O'Hare Branch)" intact (otherwise
// "Harlem (Blue - Forest Park Branch)" would collide into the same label).
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
  if (!(window in MIN_COUNT)) {
    console.error(`Unknown --window: ${window}. Use week or month.`);
    process.exit(1);
  }
  const minCount = MIN_COUNT[window];
  const { since, until, label: windowLabel } = rangeForWindow(window);

  console.log(`Train recap, ${window} (${windowLabel})`);
  const allPoints = loadTrainHeatmap(since, until);
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
  const text = buildPostText({ mode: 'train', window, windowLabel, points, totalIncidents });
  const alt = buildAltText({ mode: 'train', window, windowLabel, points, totalIncidents });

  // Include zero-gap lines so the chart shows the whole system, not just offenders.
  const gapCounts = new Map(loadGapLeaderboard('train', since, until).map((e) => [e.route, e.count]));
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
      kind: 'train', entries: rankedGapEntries, window, windowLabel, totalGaps,
      lineNames: LINE_NAMES, lineColors: LINE_COLORS,
    });
    const linesWithGaps = rankedGapEntries.filter((e) => e.count > 0).length;
    gapText = buildGapReplyText({ mode: 'train', window, windowLabel, entries: rankedGapEntries, totalGaps, routeCount: linesWithGaps, formatRoute: formatTrainRoute });
    gapAlt = buildGapReplyAlt({ mode: 'train', window, windowLabel, entries: rankedGapEntries, totalGaps, formatRoute: formatTrainRoute });
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
