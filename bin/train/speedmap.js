#!/usr/bin/env node
require('../../src/shared/env');

const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

const { LINE_NAMES, LINE_COLORS, ALL_LINES } = require('../../src/train/api');
const {
  collectTrains,
  computeTrainSamples,
  buildLineBranches,
  snapToLine,
  truncateBranchToDistance,
} = require('../../src/train/speedmap');
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
// Mostly-grey maps aren't informative — skip if too few bins have data.
// Owl/early-morning windows on infrequent lines (Pink at 2am) tend to
// produce 1–2 bins of coverage and should not post.
const MIN_COVERAGE = 0.3;

// Lines whose GTFS shape duplicates the corridor as two exact-reverse segments
// AND for which Train Tracker reports a single trDr for the whole line. The two
// physical travel directions are indistinguishable in the feed, so we render
// one combined ribbon and a single line average instead of the dual-direction
// layout. Yellow (Skokie Swift) is currently the only such line — a week of
// observations shows only trDr=1 / dest "Skokie", never a Howard-bound code.
const SINGLE_DIRECTION_LINES = new Set(['y']);

function formatAvg(summary) {
  return summary.avg == null ? 'n/a' : `${summary.avg.toFixed(1)} mph`;
}

function meanAvgMph(dirSummaries) {
  const vals = dirSummaries.map((d) => d.summary.avg).filter((v) => v != null);
  return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
}

// Branched lines (Green) have ambiguous trDr — pick the dominant destination
// among rns that contributed to this branch+direction. `allowedDests` (the
// branch's terminus station names) excludes off-branch trains that snapped
// onto the shared trunk: e.g. Cottage Grove trains on the Ashland branch's
// trunk would otherwise outvote Ashland-bound trains and collapse both
// branches to the same dest in dedupe.
function destForBranchDir(rns, trDr, destByRnDir, allowedDests = null) {
  const counts = new Map();
  for (const rn of rns) {
    const dest = destByRnDir.get(rn)?.get(trDr);
    if (!dest) continue;
    // "Loop" is the inbound destination string for loop-trunk lines
    // (Brown/Orange/Pink/Purple) — it's never a station, so allowedDests
    // (derived from polyline endpoints) would otherwise drop it.
    if (allowedDests && !allowedDests.has(dest) && dest !== 'Loop') continue;
    counts.set(dest, (counts.get(dest) || 0) + 1);
  }
  let best = null;
  for (const [dest, count] of counts) {
    if (!best || count > best.count) best = { dest, count };
  }
  return best?.dest;
}

function nearestStationName(lat, lon, stations) {
  let best = null;
  let bestD = Infinity;
  for (const st of stations) {
    const d = (st.lat - lat) ** 2 + (st.lon - lon) ** 2;
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return best?.name;
}

function branchTerminusDests(branch, stations) {
  const pts = branch.points;
  if (!pts || pts.length < 2) return new Set();
  const [a0, a1] = Array.isArray(pts[0]) ? pts[0] : [pts[0].lat, pts[0].lon];
  const last = pts[pts.length - 1];
  const [b0, b1] = Array.isArray(last) ? last : [last.lat, last.lon];
  const names = new Set();
  const start = nearestStationName(a0, a1, stations);
  const end = nearestStationName(b0, b1, stations);
  if (start) names.add(start);
  if (end) names.add(end);
  return names;
}

function dirLabel(dest) {
  return dest ? `Toward ${dest}` : 'Unknown direction';
}

function buildPostText(line, dirSummaries, startTime, endTime, callouts = [], isSingleDir = false) {
  const lineName = LINE_NAMES[line];
  const window = `${formatTimeCT(startTime)}–${formatTimeCT(endTime)} CT`;
  let body;
  let caption;
  if (isSingleDir) {
    const avg = meanAvgMph(dirSummaries);
    body = `Average: ${avg == null ? 'n/a' : `${avg.toFixed(1)} mph`}`;
    caption = `One ribbon — the CTA feed reports a single direction for the ${lineName} Line.`;
  } else {
    body = dirSummaries
      .map(({ dest, summary }) => `${dirLabel(dest)}: ${formatAvg(summary)}`)
      .join(' · ');
    caption = `Two parallel ribbons = the two travel directions.`;
  }
  const head = `🚦 ${lineName} Line speedmap\n${window}\n${body}`;
  const tail = history.formatCallouts(callouts);
  return (
    (tail ? `${head}\n${tail}\n\n` : `${head}\n\n`) +
    `${caption}\n` +
    `🟥 under 15 mph · 🟧 15–25 · 🟨 25–35 · 🟪 35–45 · 🟩 45+ · ⬜ no data`
  );
}

function buildAltText(line, dirSummaries, durationMin, isSingleDir = false) {
  const lineName = LINE_NAMES[line];
  const colorKey =
    'Red indicates under 15 mph, orange 15–25, yellow 25–35, purple 35–45, green 45 and above, gray no data.';
  if (isSingleDir) {
    const avg = meanAvgMph(dirSummaries);
    const avgStr = avg == null ? 'n/a' : `${avg.toFixed(1)} mph`;
    return `Speedmap of the CTA ${lineName} Line over a ${durationMin}-minute window, rendered as a single ribbon colored by average train speed (the CTA feed reports one direction for this line, so both travel directions are combined). Average ${avgStr}. ${colorKey}`;
  }
  const dirLines = dirSummaries
    .map(({ dest, summary }) => `${dirLabel(dest)} average ${formatAvg(summary)}`)
    .join('; ');
  return `Speedmap of the CTA ${lineName} Line over a ${durationMin}-minute window, rendered as two parallel ribbons (one per travel direction) colored by average train speed. ${dirLines}. ${colorKey}`;
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
    console.error(`No polyline data for ${LINE_NAMES[line]} line`);
    process.exit(1);
  }

  // Yellow's two segments are exact reverses of one corridor and the feed gives
  // a single trDr, so the second branch is a redundant copy. Drop it and render
  // one combined ribbon (see SINGLE_DIRECTION_LINES / buildPostText).
  const isSingleDir = SINGLE_DIRECTION_LINES.has(line);
  if (isSingleDir && branches.length > 1) branches = branches.slice(0, 1);

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
        console.log(
          `Purple shuttle hours — truncated polyline to Linden↔Howard (${(branches[0].totalFt / 5280).toFixed(1)} mi)`,
        );
      }
    }
  }

  console.log(
    `Train speedmap for ${LINE_NAMES[line]} Line, ${durationMin}min window, poll every ${POLL_INTERVAL_MS / 1000}s`,
  );
  console.log(
    `Branches: ${branches.length}` +
      branches
        .map((b, i) => `\n  [${i}] ${b.points.length} points, ${(b.totalFt / 5280).toFixed(1)} mi`)
        .join(''),
  );

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
    if (stats.offLine > 0 || stats.stationary > 0 || stats.dropped > 0 || stats.snapJump > 0) {
      console.log(
        `Branch ${i} filter: ${stats.offLine} off-line, ${stats.stationary} stationary, ${stats.dropped} out-of-range, ${stats.snapJump} snap-jump`,
      );
    }
    const numBins = Math.max(MIN_BINS, Math.round(totalFt / FT_PER_BIN));
    const binSpeedsByDir = {};
    const allowedDests = branchTerminusDests(branches[i], trainStations);
    // Loop lines emit two branches sharing one polyline, distinguished only
    // by trDrFilter. Without this scope, each branch would process both
    // directions and dedupe would leave duplicate entries.
    const trDrFilter = branches[i].trDrFilter || null;
    // Single-direction lines (Yellow): the feed can't tell the two travel
    // directions apart, so merge every sample into one ribbon keyed 'all'
    // rather than emitting a per-trDr entry.
    const dirGroups = isSingleDir
      ? [['all', Array.from(byDir.values()).flat()]]
      : Array.from(byDir);
    for (const [trDr, samples] of dirGroups) {
      if (trDrFilter && trDr !== trDrFilter) continue;
      binSpeedsByDir[trDr] = binSegments(samples, totalFt, numBins);
      const s = summarize(binSpeedsByDir[trDr], TRAIN_THRESHOLDS);
      const dest = isSingleDir
        ? null
        : destForBranchDir(rnsByDir.get(trDr) || new Set(), trDr, destByRnDir, allowedDests);
      const label = isSingleDir ? 'combined' : dirLabel(dest);
      console.log(
        `Branch ${i} / ${label} (dir ${trDr}): ${samples.length} samples · avg ${s.avg?.toFixed(1)} mph · red=${s.red} orange=${s.orange} yellow=${s.yellow} purple=${s.purple} green=${s.green}`,
      );
      dirSummaries.push({ dest, summary: s, numBins });
    }
    branchData.push({ points, cumDist, binSpeedsByDir });
  }

  // Collapse duplicate destinations (Green's trunk direction shows up twice).
  const dedupedByDest = new Map();
  for (const entry of dirSummaries) {
    const key = entry.dest || `unknown-${dedupedByDest.size}`;
    if (
      !dedupedByDest.has(key) ||
      (entry.summary.avg != null && dedupedByDest.get(key).summary.avg == null)
    ) {
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
        pctRed: 0,
        pctOrange: 0,
        pctYellow: 0,
        pctGreen: 0,
        binSpeeds: [],
        posted: false,
      });
    }
    return;
  }

  // Sparse coverage → mostly-grey map isn't informative.
  const totalBins = finalDirs.reduce((acc, d) => acc + d.numBins, 0);
  const validBins = finalDirs.reduce((acc, d) => {
    const s = d.summary;
    return acc + s.red + s.orange + s.yellow + (s.purple || 0) + s.green;
  }, 0);
  const coverage = totalBins > 0 ? validBins / totalBins : 0;
  if (coverage < MIN_COVERAGE) {
    console.log(
      `Sparse coverage for ${LINE_NAMES[line]} Line: ${validBins}/${totalBins} bins (${(coverage * 100).toFixed(0)}%) — not posting`,
    );
    if (!argv['dry-run']) {
      history.recordSpeedmap({
        kind: 'train',
        route: line,
        direction: null,
        avgMph: null,
        pctRed: 0,
        pctOrange: 0,
        pctYellow: 0,
        pctGreen: 0,
        binSpeeds: [],
        posted: false,
      });
    }
    return;
  }

  // Mean of per-direction averages — the callout reads "this line was slow today",
  // not "this direction was slow."
  const dirAvgs = finalDirs.map((d) => d.summary.avg).filter((v) => v != null);
  const lineAvgMph =
    dirAvgs.length > 0 ? dirAvgs.reduce((a, v) => a + v, 0) / dirAvgs.length : null;
  const callouts = history.speedmapCallouts({
    kind: 'train',
    route: line,
    avgMph: lineAvgMph,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  const lineColor = LINE_COLORS[line];
  const image = await renderTrainSpeedmap(branchData, lineColor);
  const text = buildPostText(line, finalDirs, startTime, endTime, callouts, isSingleDir);
  const alt = buildAltText(line, finalDirs, durationMin, isSingleDir);

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(
      image,
      `train-speedmap-${LINE_NAMES[line].toLowerCase()}-${Date.now()}.jpg`,
    );
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginTrain();
  const result = await postWithImage(agent, text, image, alt);
  // One row per run so callout MIN/MAX is apples-to-apples with lineAvgMph.
  const totals = finalDirs.reduce(
    (acc, { summary }) => {
      acc.red += summary.red;
      acc.orange += summary.orange;
      acc.yellow += summary.yellow;
      acc.purple += summary.purple;
      acc.green += summary.green;
      return acc;
    },
    { red: 0, orange: 0, yellow: 0, purple: 0, green: 0 },
  );
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

// Guard so tests can require the post/alt-text builders without invoking main
// (which polls the live CTA feed). Running the file directly still executes.
if (require.main === module) runBin(main);

module.exports = { buildPostText, buildAltText, SINGLE_DIRECTION_LINES };
