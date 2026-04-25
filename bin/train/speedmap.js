#!/usr/bin/env node
require('../../src/shared/env');

const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

const { LINE_NAMES, LINE_COLORS, ALL_LINES } = require('../../src/train/api');
const { collectTrains, computeTrainSamples, buildLineBranches, snapToLine, truncateBranchToDistance } = require('../../src/train/speedmap');
const { binSegments, summarize, TRAIN_THRESHOLDS } = require('../../src/bus/speedmap');
const { renderTrainSpeedmap } = require('../../src/map');
const { loginTrain, postWithImage } = require('../../src/train/bluesky');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { formatTimeCT } = require('../../src/shared/format');
const { expectedTrainTripMinutes } = require('../../src/shared/gtfs');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

// 0.5 mi/bin gives uniform spatial resolution across lines (a flat bin count
// left Yellow's 5-mi route mostly no-data). Floor keeps short branches readable.
const FT_PER_BIN = 2640;
const MIN_BINS = 8;
const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_DURATION_MIN = 60;

function formatAvg(summary) {
  return summary.avg == null ? 'n/a' : `${summary.avg.toFixed(1)} mph`;
}

// Branched lines (Green) have ambiguous trDr — pick the dominant destination
// among rns that contributed to this branch+direction.
function destForBranchDir(rns, trDr, destByRnDir) {
  const counts = new Map();
  for (const rn of rns) {
    const dest = destByRnDir.get(rn)?.get(trDr);
    if (!dest) continue;
    counts.set(dest, (counts.get(dest) || 0) + 1);
  }
  let best = null;
  for (const [dest, count] of counts) {
    if (!best || count > best.count) best = { dest, count };
  }
  return best?.dest;
}

function dirLabel(dest) {
  return dest ? `Toward ${dest}` : 'Unknown direction';
}

function buildPostText(line, dirSummaries, startTime, endTime, callouts = []) {
  const lineName = LINE_NAMES[line];
  const window = `${formatTimeCT(startTime)}–${formatTimeCT(endTime)} CT`;
  const dirLines = dirSummaries
    .map(({ dest, summary }) => `${dirLabel(dest)}: ${formatAvg(summary)}`)
    .join(' · ');
  const head = `🚦 ${lineName} Line speedmap\n${window}\n${dirLines}`;
  const tail = history.formatCallouts(callouts);
  return (
    (tail ? `${head}\n${tail}\n\n` : `${head}\n\n`) +
    `Two parallel ribbons = the two travel directions.\n` +
    `🟥 under 15 mph · 🟧 15–25 · 🟨 25–35 · 🟪 35–45 · 🟩 45+ · ⬜ no data`
  );
}

function buildAltText(line, dirSummaries, durationMin) {
  const lineName = LINE_NAMES[line];
  const dirLines = dirSummaries
    .map(({ dest, summary }) => `${dirLabel(dest)} average ${formatAvg(summary)}`)
    .join('; ');
  return `Speedmap of the CTA ${lineName} Line over a ${durationMin}-minute window, rendered as two parallel ribbons (one per travel direction) colored by average train speed. ${dirLines}. Red indicates under 15 mph, orange 15–25, yellow 25–35, purple 35–45, green 45 and above, gray no data.`;
}

async function main() {
  setup();
  const line = argv.line || history.leastRecentlyPostedSpeedmapRoute('train', ALL_LINES);
  const durationMin = argv.duration ? Number(argv.duration) : DEFAULT_DURATION_MIN;
  const durationMs = durationMin * 60 * 1000;

  if (!LINE_NAMES[line]) {
    console.error(`Unknown line: ${line}`);
    process.exit(1);
  }

  let branches = buildLineBranches(trainLines, line);
  if (branches.length === 0 || branches[0].points.length < 2) {
    console.error(`No polyline data for ${line} line`);
    process.exit(1);
  }

  // Purple shuttle (Linden↔Howard) hours: GTFS trip duration (~14 min vs ~95
  // express) tells us to truncate the express portion of the polyline.
  // Check both window edges to cover boundary-straddling runs.
  if (line === 'p') {
    const windowStart = new Date();
    const windowEnd = new Date(windowStart.getTime() + durationMs);
    const startMin = expectedTrainTripMinutes('p', null, windowStart);
    const endMin = expectedTrainTripMinutes('p', null, windowEnd);
    const expressRunning = (startMin != null && startMin > 50) || (endMin != null && endMin > 50);
    if (!expressRunning) {
      const howard = trainStations.find((s) => s.name === 'Howard');
      if (howard && branches[0]) {
        const b = branches[0];
        const howardDist = snapToLine(howard.lat, howard.lon, b.points, b.cumDist);
        branches = [truncateBranchToDistance(b, howardDist)];
        console.log(`Purple shuttle hours — truncated polyline to Linden↔Howard (${(branches[0].totalFt / 5280).toFixed(1)} mi)`);
      }
    }
  }

  console.log(`Train speedmap for ${LINE_NAMES[line]} Line, ${durationMin}min window, poll every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Branches: ${branches.length}` + branches.map((b, i) => `\n  [${i}] ${b.points.length} points, ${(b.totalFt / 5280).toFixed(1)} mi`).join(''));

  const startTime = new Date();
  const { tracks, destByRnDir } = await collectTrains(line, durationMs, POLL_INTERVAL_MS);
  const endTime = new Date();

  // Per-branch processing — each branch's samples resolve to its own destination
  // labels (Green's trDr=5 → "Ashland/63rd" on branch 0, "Cottage Grove" on 1).
  const branchData = [];
  const dirSummaries = [];
  for (let i = 0; i < branches.length; i++) {
    const { points, cumDist, totalFt } = branches[i];
    const { byDir, rnsByDir, stats } = computeTrainSamples(tracks, points, cumDist);
    if (stats.offLine > 0 || stats.stationary > 0 || stats.dropped > 0) {
      console.log(`Branch ${i} filter: ${stats.offLine} off-line, ${stats.stationary} stationary, ${stats.dropped} out-of-range`);
    }
    const numBins = Math.max(MIN_BINS, Math.round(totalFt / FT_PER_BIN));
    const binSpeedsByDir = {};
    for (const [trDr, samples] of byDir) {
      binSpeedsByDir[trDr] = binSegments(samples, totalFt, numBins);
      const s = summarize(binSpeedsByDir[trDr], TRAIN_THRESHOLDS);
      const dest = destForBranchDir(rnsByDir.get(trDr) || new Set(), trDr, destByRnDir);
      const label = dirLabel(dest);
      console.log(`Branch ${i} / ${label} (dir ${trDr}): ${samples.length} samples · avg ${s.avg?.toFixed(1)} mph · red=${s.red} orange=${s.orange} yellow=${s.yellow} purple=${s.purple} green=${s.green}`);
      dirSummaries.push({ dest, summary: s });
    }
    branchData.push({ points, cumDist, binSpeedsByDir });
  }

  // Collapse duplicate destinations (Green's trunk direction shows up twice).
  const dedupedByDest = new Map();
  for (const entry of dirSummaries) {
    const key = entry.dest || `unknown-${dedupedByDest.size}`;
    if (!dedupedByDest.has(key) || (entry.summary.avg != null && dedupedByDest.get(key).summary.avg == null)) {
      dedupedByDest.set(key, entry);
    }
  }
  const finalDirs = Array.from(dedupedByDest.values());

  // No averages → line wasn't running this window (Yellow/Purple express/owl gaps).
  if (finalDirs.every((d) => d.summary.avg == null)) {
    console.log(`No train samples for ${LINE_NAMES[line]} Line during the window — not posting`);
    if (!argv['dry-run']) {
      history.recordSpeedmap({
        kind: 'train',
        route: line,
        direction: null,
        avgMph: null,
        pctRed: 0, pctOrange: 0, pctYellow: 0, pctGreen: 0,
        binSpeeds: [],
        posted: false,
      });
    }
    return;
  }

  // Mean of per-direction averages — the callout reads "this line was slow today",
  // not "this direction was slow."
  const dirAvgs = finalDirs.map((d) => d.summary.avg).filter((v) => v != null);
  const lineAvgMph = dirAvgs.length > 0 ? dirAvgs.reduce((a, v) => a + v, 0) / dirAvgs.length : null;
  const callouts = history.speedmapCallouts({
    kind: 'train',
    route: line,
    avgMph: lineAvgMph,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  const lineColor = LINE_COLORS[line];
  const image = await renderTrainSpeedmap(branchData, lineColor);
  const text = buildPostText(line, finalDirs, startTime, endTime, callouts);
  const alt = buildAltText(line, finalDirs, durationMin);

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(image, `train-speedmap-${LINE_NAMES[line].toLowerCase()}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginTrain();
  const result = await postWithImage(agent, text, image, alt);
  // One row per run so callout MIN/MAX is apples-to-apples with lineAvgMph.
  const totals = finalDirs.reduce((acc, { summary }) => {
    acc.red += summary.red;
    acc.orange += summary.orange;
    acc.yellow += summary.yellow;
    acc.purple += summary.purple;
    acc.green += summary.green;
    return acc;
  }, { red: 0, orange: 0, yellow: 0, purple: 0, green: 0 });
  const totalValid = totals.red + totals.orange + totals.yellow + totals.purple + totals.green;
  history.recordSpeedmap({
    kind: 'train',
    route: line,
    direction: null,
    avgMph: lineAvgMph,
    pctRed: totalValid ? totals.red / totalValid : 0,
    pctOrange: totalValid ? totals.orange / totalValid : 0,
    pctYellow: totalValid ? totals.yellow / totalValid : 0,
    pctPurple: totalValid ? totals.purple / totalValid : 0,
    pctGreen: totalValid ? totals.green / totalValid : 0,
    binSpeeds: [],
    posted: true,
    postUri: result.uri,
  });
  console.log(`Posted: ${result.url}`);
}

runBin(main);
