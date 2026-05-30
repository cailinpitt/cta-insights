const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getAllTrainPositions, shortStationName } = require('./api');
const { TYPICAL_TRAIN_SPEED_FT_PER_MIN } = require('./gaps');
const { computeTrainGapVideoView } = require('../map');
const { fetchTrainBunchingBaseMap, renderTrainBunchingFrame } = require('../map/train/bunching');
const { clampTrackSeries, attachTrails } = require('./bunchingVideo');
const { smoothSeries } = require('../shared/stats');
const { buildLinePolyline, snapToLine, pointAlongLine } = require('./speedmap');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 10 min of real time
const DEFAULT_INTERPOLATE = 4;
const DEFAULT_FRAMERATE = 16;

// Frame can't be wider than this trailing-train→stop distance, or the markers
// shrink to specks and 10 min of motion is imperceptible. Beyond it the gap is
// "too deep for a useful clip" → caller falls back to the still map. Anchored at
// the gap midpoint, so this caps the *half*-gap: 5 mi covers gaps up to ~24 min.
const MAX_APPROACH_FT = 26_400; // 5 mi
// Post-capture floor: if the next train didn't meaningfully close on the stop
// (and never reached it), there's no story — skip the clip, keep the still.
const MIN_APPROACH_FT = 1_320; // 0.25 mi
// Treat the train as "arrived" once this close to the stop.
const ARRIVED_FT = 500;
// Comet trail window, matching the bunching clips.
const TRAIL_MS = 75_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One frame's HUD readout. `deltaFt` is the *signed* distance from the trailing
// ("Next up") train to the midpoint wait stop (stopTrack - track): positive
// while still approaching, ~0 at the stop, and negative once the train has
// passed and pulled away. Three states so the label tracks the train past the
// stop instead of getting stuck on "reaching" forever once it clamps to 0.
function gapReadout(gapMin, stopName, deltaFt) {
  const head = `~${gapMin}-min gap · next train`;
  if (deltaFt < -ARRIVED_FT) return stopName ? `${head} has left ${stopName}` : `${head} has left`;
  if (deltaFt <= ARRIVED_FT) return stopName ? `${head} reaching ${stopName}` : `${head} arriving`;
  const min = Math.max(1, Math.round(deltaFt / TYPICAL_TRAIN_SPEED_FT_PER_MIN));
  return stopName ? `${head} ~${min} min to ${stopName}` : `${head} ~${min} min`;
}

function stopTrackDist(gap, linePts, lineCum) {
  const s = gap.nearStation;
  if (!s || s.lat == null || s.lon == null) return null;
  return snapToLine(s.lat, s.lon, linePts, lineCum);
}

// Poll the trailing ("Next up") train's position over the clip window. Returns
// null when the gap is too deep to frame, the train resolves before we start,
// or too few frames land to build a clip.
async function captureTrainGapVideo(gap, lineColors, trainLines, stations, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;

  const { points: linePts, cumDist: lineCum } = buildLinePolyline(trainLines, gap.line);
  if (linePts.length < 2) return null;
  const stopTrack = stopTrackDist(gap, linePts, lineCum);
  if (stopTrack == null) return null;

  const rn = gap.trailing?.rn;
  if (rn == null) return null;
  const startTrack = snapToLine(gap.trailing.lat, gap.trailing.lon, linePts, lineCum);
  const startRemaining = stopTrack - startTrack;
  // Trailing is upstream of the wait stop by construction; if it's already at or
  // past the stop the gap is resolving — nothing to film.
  if (startRemaining <= ARRIVED_FT) return null;
  if (startRemaining > MAX_APPROACH_FT) return null;

  const snapshots = [{ ts: Date.now(), train: gap.trailing }];
  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    let train = null;
    try {
      const all = await getAllTrainPositions([gap.line]);
      train = all.find((t) => t.line === gap.line && t.rn === rn) || null;
    } catch (e) {
      console.warn(`train gap video tick ${i}: fetch failed — ${e.message}`);
      continue;
    }
    if (!train) {
      console.log(`train gap video: trailing run ${rn} dropped at tick ${i}, stopping`);
      break;
    }
    snapshots.push({ ts: Date.now(), train });
  }

  if (snapshots.length < 2) return null;
  return renderTrainGapClip(snapshots, gap, lineColors, trainLines, stations, {
    ...opts,
    stopTrack,
  });
}

// Assemble + encode the clip from captured snapshots. Split out so it can be
// driven with reconstructed/historical data in tests.
async function renderTrainGapClip(snapshots, gap, lineColors, trainLines, stations, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  if (snapshots.length < 2) return null;

  const { points: linePts, cumDist: lineCum } = buildLinePolyline(trainLines, gap.line);
  const stopTrack = opts.stopTrack != null ? opts.stopTrack : stopTrackDist(gap, linePts, lineCum);
  if (stopTrack == null) return null;

  // Clean the trailing train's track series: snap → reject teleports → clamp
  // toward the stop → smooth, then rewrite lat/lon onto the polyline.
  const rawTracks = snapshots.map((s) => snapToLine(s.train.lat, s.train.lon, linePts, lineCum));
  const tracks = smoothSeries(clampTrackSeries(rawTracks));
  for (let i = 0; i < snapshots.length; i++) {
    snapshots[i].train.track = tracks[i];
    const p = pointAlongLine(linePts, lineCum, tracks[i]);
    if (p) {
      snapshots[i].train.lat = p.lat;
      snapshots[i].train.lon = p.lon;
    }
  }

  const trailingPath = snapshots.map((s) => ({ lat: s.train.lat, lon: s.train.lon }));
  const view = computeTrainGapVideoView(gap, trailingPath, lineColors, trainLines, stations);
  const baseMap = await fetchTrainBunchingBaseMap(view);

  // The trailing train keeps the "N" (Next up) chip it carries on the still map.
  const labels = new Map();
  if (gap.trailing.rn != null) labels.set(gap.trailing.rn, 'N');

  // Lead the HUD with the full gap so the ticking ETA (which is only the time
  // to the *midpoint* — the back half of the gap) doesn't undersell it. Name
  // that midpoint stop in the ETA ("~N min to Pulaski") so it's clear what the
  // countdown measures; it matches the amber wait-stop label on the map.
  const gapMin = Math.round(gap.gapMin);
  const stopName = shortStationName(gap.nearStation?.name);
  const readoutFor = (track) => gapReadout(gapMin, stopName, stopTrack - track);

  const trainFrames = [];
  const frameTimes = [];
  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = snapshots[i].train;
    const b = snapshots[i + 1].train;
    for (let k = 0; k < interpolate; k++) {
      const t = k / interpolate;
      const track = a.track + (b.track - a.track) * t;
      const p = pointAlongLine(linePts, lineCum, track);
      const lat = p ? p.lat : a.lat + (b.lat - a.lat) * t;
      const lon = p ? p.lon : a.lon + (b.lon - a.lon) * t;
      trainFrames.push([
        {
          rn: a.rn,
          line: a.line,
          lat,
          lon,
          heading: a.heading,
          destination: a.destination,
          nextStation: a.nextStation,
          trDr: a.trDr,
          track,
        },
      ]);
      frameTimes.push(snapshots[i].ts + (snapshots[i + 1].ts - snapshots[i].ts) * t);
    }
  }
  const last = snapshots[snapshots.length - 1].train;
  trainFrames.push([{ ...last }]);
  frameTimes.push(snapshots[snapshots.length - 1].ts);

  const trailFrames = Math.max(2, Math.round(TRAIL_MS / (tickMs / interpolate)));
  attachTrails(trainFrames, trailFrames);

  const clipStartTs = snapshots[0].ts;
  const videoEndTs = snapshots[snapshots.length - 1].ts;
  const totalSec = Math.max(1, (videoEndTs - clipStartTs) / 1000);

  const startRemaining = Math.max(0, stopTrack - snapshots[0].train.track);
  const endRemaining = Math.max(0, stopTrack - last.track);
  const reached = endRemaining <= ARRIVED_FT;
  // No meaningful approach and never arrived → not worth a clip.
  if (!reached && startRemaining - endRemaining < MIN_APPROACH_FT) return null;

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-train-gap-video-'));
  try {
    for (let i = 0; i < trainFrames.length; i++) {
      const buf = await renderTrainBunchingFrame(view, baseMap, trainFrames[i], {
        labels,
        clock: { elapsedSec: (frameTimes[i] - clipStartTs) / 1000, totalSec },
        readout: readoutFor(trainFrames[i][0].track),
        highlightStation: gap.nearStation?.name || null,
      });
      await Fs.writeFile(Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`), buf);
    }
    const holdFrames = framerate;
    const lastIdx = trainFrames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(3, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      await Fs.copyFile(
        lastPath,
        Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(3, '0')}.jpg`),
      );
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
    const cmd = [
      'ffmpeg -y -hide_banner -loglevel error',
      `-framerate ${framerate}`,
      `-i "${Path.join(tmpDir, 'frame_%03d.jpg')}"`,
      '-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"',
      '-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart',
      `"${outPath}"`,
    ].join(' ');
    await execP(cmd, { timeout: 60_000 });
    const buffer = await Fs.readFile(outPath);

    return {
      buffer,
      elapsedSec: Math.round((videoEndTs - clipStartTs) / 1000),
      startDistFt: Math.round(startRemaining),
      endDistFt: Math.round(endRemaining),
      reached,
      gapMin: Math.round(gap.gapMin),
      stopName: gap.nearStation?.name || null,
    };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = {
  captureTrainGapVideo,
  renderTrainGapClip,
  gapReadout,
  MAX_APPROACH_FT,
  MIN_APPROACH_FT,
  ARRIVED_FT,
};
