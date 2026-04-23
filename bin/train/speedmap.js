#!/usr/bin/env node
require('../../src/shared/env');

const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

const { LINE_NAMES, LINE_COLORS, ALL_LINES } = require('../../src/train/api');
const { collectTrains, computeTrainSamples, buildLineBranches, snapToLine, truncateBranchToDistance } = require('../../src/train/speedmap');
const { binSamples, summarize, TRAIN_THRESHOLDS } = require('../../src/bus/speedmap');
const { renderTrainSpeedmap } = require('../../src/map');
const { loginTrain, postWithImage } = require('../../src/train/bluesky');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { formatTimeCT } = require('../../src/shared/format');
const { expectedTrainTripMinutes } = require('../../src/shared/gtfs');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

// ~0.5 mi per bin keeps spatial resolution uniform across lines. A flat bin
// count made Yellow (~5 mi) look sparse: with only 2 trains in service and
// 660-ft bins, most bins ended a 60-min window empty and rendered as no-data
// grey. Floor at 8 so trivially short branches still produce a readable ribbon.
const FT_PER_BIN = 2640;
const MIN_BINS = 8;
const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_DURATION_MIN = 60;

function formatAvg(summary) {
  return summary.avg == null ? 'n/a' : `${summary.avg.toFixed(1)} mph`;
}

// Pick the most common destination among the rns contributing to this branch +
// direction. Needed for branched lines (Green) where trDr=5 can mean either
// "Toward Ashland/63rd" or "Toward Cottage Grove" depending on which branch
// the train is actually on.
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
  const line = argv.line || _.sample(ALL_LINES);
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

  // Purple's polyline covers the full Linden→Loop express route, but outside
  // rush hours the service is a Linden↔Howard shuttle and the express portion
  // renders as a long grey halo to nowhere. Use the scheduled trip duration
  // (GTFS) as the signal: an express trip is ~95 min end-to-end, a shuttle
  // trip is ~14 min, so anything above ~50 min means express is running.
  // Check both ends of the collection window so a boundary-straddling run
  // (e.g. 08:30–09:30) still gets the full polyline.
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

  // Process each branch independently: snap samples to this branch's polyline
  // (rejecting ones > MAX_SNAP_PERP_FT away), bin per direction, resolve the
  // dominant destination per direction from the rns that contributed. On Green,
  // trDr=5 samples on branch 0 resolve to "Ashland/63rd" and on branch 1 to
  // "Cottage Grove", giving each branch its own correct label.
  const branchData = [];
  const dirSummaries = []; // [{ dest, summary }] — one entry per (branch, direction)
  for (let i = 0; i < branches.length; i++) {
    const { points, cumDist, totalFt } = branches[i];
    const { byDir, rnsByDir, stats } = computeTrainSamples(tracks, points, cumDist);
    if (stats.offLine > 0 || stats.stationary > 0 || stats.dropped > 0) {
      console.log(`Branch ${i} filter: ${stats.offLine} off-line, ${stats.stationary} stationary, ${stats.dropped} out-of-range`);
    }
    const numBins = Math.max(MIN_BINS, Math.round(totalFt / FT_PER_BIN));
    const binSpeedsByDir = {};
    for (const [trDr, samples] of byDir) {
      binSpeedsByDir[trDr] = binSamples(samples, totalFt, numBins);
      const s = summarize(binSpeedsByDir[trDr], TRAIN_THRESHOLDS);
      const dest = destForBranchDir(rnsByDir.get(trDr) || new Set(), trDr, destByRnDir);
      const label = dirLabel(dest);
      console.log(`Branch ${i} / ${label} (dir ${trDr}): ${samples.length} samples · avg ${s.avg?.toFixed(1)} mph · red=${s.red} orange=${s.orange} yellow=${s.yellow} purple=${s.purple} green=${s.green}`);
      dirSummaries.push({ dest, summary: s });
    }
    branchData.push({ points, cumDist, binSpeedsByDir });
  }

  // Collapse duplicate destinations (e.g. "Toward Harlem/Lake" appears on both
  // Green branches' trunk direction) — keep the one with the highest sample
  // count so the caption isn't repetitive.
  const dedupedByDest = new Map();
  for (const entry of dirSummaries) {
    const key = entry.dest || `unknown-${dedupedByDest.size}`;
    if (!dedupedByDest.has(key) || (entry.summary.avg != null && dedupedByDest.get(key).summary.avg == null)) {
      dedupedByDest.set(key, entry);
    }
  }
  const finalDirs = Array.from(dedupedByDest.values());

  // If no direction has a valid average speed, the line wasn't running during
  // the window (common for the non-24/7 lines — Yellow, Purple express, etc.,
  // overnight gaps). Skip rather than posting an empty speedmap.
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

  // Line-level avg across directions (simple mean of per-direction averages)
  // drives the severity callout. Using an average keeps the semantic "this
  // line was slow today" rather than attributing it to one direction.
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
  // One row per run (line-level aggregation) so callout MIN/MAX is
  // apples-to-apples with the line avg we compute on each run.
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
