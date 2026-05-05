#!/usr/bin/env node
// One-off preview: render a real train gap with two map styles side-by-side
// so we can pick a direction. Writes:
//   /tmp/gap-classic.jpg   — what production renders today
//   /tmp/gap-minimal.jpg   — amber gap segment, only flanking stations labeled/pinned
//
// Usage: node scripts/preview-train-gap.js [--line=red] [--dir=5]
// Without args, picks the largest currently-detected gap on any line.
require('../src/shared/env');

const Fs = require('node:fs');
const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS } = require('../src/train/api');
const { detectAllTrainGaps } = require('../src/train/gaps');
const { findStationByDestination } = require('../src/train/findStation');
const { expectedTrainHeadwayMin } = require('../src/shared/gtfs');
const trainLines = require('../src/train/data/trainLines.json');
const trainStations = require('../src/train/data/trainStations.json');

const {
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
} = require('../src/map/train/bunching');
const { encode } = require('../src/shared/polyline');
const { buildLinePolyline, pointAlongLine } = require('../src/train/speedmap');

const CLASSIC_COLOR = 'ff00ff'; // current production magenta
const MINIMAL_COLOR = 'ffb020'; // proposed warm amber
const STROKE = 10;

function buildGapOverlay(gap, color) {
  const { points, cumDist } = buildLinePolyline(trainLines, gap.line);
  const lo = Math.min(gap.leadingTrackDist, gap.trailingTrackDist);
  const hi = Math.max(gap.leadingTrackDist, gap.trailingTrackDist);
  const loPt = pointAlongLine(points, cumDist, lo);
  const hiPt = pointAlongLine(points, cumDist, hi);
  const gapPts = [];
  if (loPt) gapPts.push([loPt.lat, loPt.lon]);
  for (let i = 0; i < points.length; i++) {
    if (cumDist[i] > lo && cumDist[i] < hi) gapPts.push(points[i]);
  }
  if (hiPt) gapPts.push([hiPt.lat, hiPt.lon]);
  if (gapPts.length < 2) return null;
  return `path-${STROKE}+${color}(${encodeURIComponent(encode(gapPts))})`;
}

function spliceGapOverlay(view, overlay) {
  const firstPin = view.overlays.findIndex((o) => o.startsWith('pin-'));
  const insertAt = firstPin === -1 ? view.overlays.length : firstPin;
  view.overlays.splice(insertAt, 0, overlay);
}

function nearestStationOnLine(stationsWithDist, trackDist) {
  let best = null;
  let bestDelta = Infinity;
  for (const s of stationsWithDist) {
    const d = Math.abs(s.trackDist - trackDist);
    if (d < bestDelta) {
      best = s;
      bestDelta = d;
    }
  }
  return best;
}

function buildClassicView(gap) {
  const bunch = { line: gap.line, trDr: gap.trDr, trains: [gap.leading, gap.trailing] };
  const view = computeTrainBunchingView(bunch, LINE_COLORS, trainLines, trainStations, [], {
    fitBbox: true,
  });
  const overlay = buildGapOverlay(gap, CLASSIC_COLOR);
  if (overlay) spliceGapOverlay(view, overlay);
  return view;
}

function buildMinimalView(gap) {
  const bunch = { line: gap.line, trDr: gap.trDr, trains: [gap.leading, gap.trailing] };
  const view = computeTrainBunchingView(bunch, LINE_COLORS, trainLines, trainStations, [], {
    fitBbox: true,
  });

  // Strip out every station pin/label, then re-add only the two stations
  // immediately flanking the gap (one just outside each train) so a reader has
  // a name to anchor each end of the gap to.
  view.overlays = view.overlays.filter((o) => !o.startsWith('pin-'));

  const { snapToLine } = require('../src/train/speedmap');
  const { points: linePts, cumDist: lineCumDist } = buildLinePolyline(trainLines, gap.line);
  const onLineStations = (trainStations || []).filter((s) => s.lines?.includes(gap.line));
  const stationsWithDist = onLineStations.map((s) => ({
    station: s,
    trackDist: snapToLine(s.lat, s.lon, linePts, lineCumDist),
  }));

  const lo = Math.min(gap.leadingTrackDist, gap.trailingTrackDist);
  const hi = Math.max(gap.leadingTrackDist, gap.trailingTrackDist);
  const justOutsideLo = stationsWithDist
    .filter((s) => s.trackDist < lo)
    .sort((a, b) => b.trackDist - a.trackDist)[0];
  const justOutsideHi = stationsWithDist
    .filter((s) => s.trackDist > hi)
    .sort((a, b) => a.trackDist - b.trackDist)[0];
  const flank = [justOutsideLo, justOutsideHi].filter(Boolean).map((s) => s.station);

  // Re-pin those flank stations so they show on the basemap.
  for (const s of flank) {
    view.overlays.push(`pin-s+ffffff(${s.lon.toFixed(5)},${s.lat.toFixed(5)})`);
  }

  // Replace visibleStations (labeled) and pinStations (drawn pins) with just
  // the flank set. The renderer reads these to lay down labels and reserves.
  const flankNames = new Set(flank.map((s) => s.name));
  view.visibleStations = view.visibleStations.filter((v) => flankNames.has(v.station.name));
  view.pinStations = view.pinStations.filter((p) => flankNames.has(p.station.name));

  const overlay = buildGapOverlay(gap, MINIMAL_COLOR);
  if (overlay) spliceGapOverlay(view, overlay);
  return view;
}

async function render(view, gap, outPath) {
  const baseMap = await fetchTrainBunchingBaseMap(view);
  const buf = await renderTrainBunchingFrame(view, baseMap, [gap.leading, gap.trailing]);
  Fs.writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} (${buf.length} bytes)`);
}

async function main() {
  console.log('Fetching live train positions...');
  const trains = await getAllTrainPositions();
  const gaps = detectAllTrainGaps(
    trains,
    trainLines,
    trainStations,
    findStationByDestination,
    (line, destStation) => expectedTrainHeadwayMin(line, destStation),
  );
  if (gaps.length === 0) {
    console.error('No gaps detected right now. Try again later.');
    process.exit(1);
  }

  let gap = gaps[0];
  if (argv.line || argv.dir) {
    const match = gaps.find(
      (g) =>
        (argv.line == null || g.line === argv.line) &&
        (argv.dir == null || String(g.trDr) === String(argv.dir)),
    );
    if (match) gap = match;
  }
  console.log(
    `Using ${gap.line} ${gap.trDr} → ${gap.leading.destination}; gap=${gap.gapMin.toFixed(1)}min near ${gap.nearStation?.name || '?'}`,
  );

  const classicView = buildClassicView(gap);
  await render(classicView, gap, '/tmp/gap-classic.jpg');

  const minimalView = buildMinimalView(gap);
  await render(minimalView, gap, '/tmp/gap-minimal.jpg');
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
