const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getVehicles } = require('./api');
const { TYPICAL_SPEED_FT_PER_MIN } = require('./gaps');
const { computeBunchingView, fetchBunchingBaseMap, renderBunchingFrame } = require('../map');
const { attachTrails } = require('./bunchingVideo');
const { cumulativeDistances } = require('../shared/geo');
const { smoothSeries } = require('../shared/stats');
const { snapToLine, pointAlongLine } = require('../train/speedmap');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 10 min of real time
const DEFAULT_INTERPOLATE = 4;
const DEFAULT_FRAMERATE = 16;

// Buses are slow (~880 ft/min), so the readable-frame ceiling and the
// "did it actually close?" floor are tighter than the train clip's. The clip
// aims at the gap midpoint (see bin/bus/gaps.js), so this caps the *half*-gap:
// 3 mi covers gaps up to ~36 min (the 15-min detection floor is ~1.25 mi).
const MAX_APPROACH_FT = 15_840; // 3 mi
const MIN_APPROACH_FT = 660; // 0.125 mi
const ARRIVED_FT = 400;
const TRAIL_MS = 75_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function patternLine(pattern) {
  const linePts = pattern.points.map((p) => [p.lat, p.lon]);
  return { linePts, lineCum: cumulativeDistances(pattern.points) };
}

// Poll the trailing ("Next up") bus over the clip window. Returns null when the
// gap is too deep to frame, the bus resolves before we start, or too few frames
// land to build a clip.
async function captureBusGapVideo(gap, pattern, stop, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;

  const { linePts, lineCum } = patternLine(pattern);
  if (linePts.length < 2) return null;
  if (stop?.lat == null || stop?.lon == null) return null;
  const stopTrack = snapToLine(stop.lat, stop.lon, linePts, lineCum);

  const vid = gap.trailing?.vid;
  if (vid == null) return null;
  const startTrack = snapToLine(gap.trailing.lat, gap.trailing.lon, linePts, lineCum);
  const startRemaining = stopTrack - startTrack;
  if (startRemaining <= ARRIVED_FT) return null;
  if (startRemaining > MAX_APPROACH_FT) return null;

  const snapshots = [{ ts: Date.now(), vehicle: gap.trailing }];
  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    let vehicle = null;
    try {
      const all = await getVehicles([gap.route], { record: false });
      vehicle = all.find((v) => v.vid === vid && v.pid === gap.pid) || null;
    } catch (e) {
      console.warn(`bus gap video tick ${i}: fetch failed — ${e.message}`);
      continue;
    }
    if (!vehicle) {
      console.log(`bus gap video: trailing vid ${vid} dropped at tick ${i}, stopping`);
      break;
    }
    snapshots.push({ ts: Date.now(), vehicle });
  }

  if (snapshots.length < 2) return null;
  return renderBusGapClip(snapshots, gap, pattern, stop, { ...opts, stopTrack });
}

// Assemble + encode the clip from captured snapshots. Split out so it can be
// driven with reconstructed data in tests.
async function renderBusGapClip(snapshots, gap, pattern, stop, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  if (snapshots.length < 2) return null;

  const { linePts, lineCum } = patternLine(pattern);
  const stopTrack =
    opts.stopTrack != null ? opts.stopTrack : snapToLine(stop.lat, stop.lon, linePts, lineCum);

  // Clean the trailing bus's track series: snap → clamp non-decreasing (buses
  // run one direction on a pattern) → smooth, then rewrite lat/lon on the line.
  const raw = snapshots.map((s) => snapToLine(s.vehicle.lat, s.vehicle.lon, linePts, lineCum));
  let prev = null;
  const clamped = raw.map((r) => {
    const next = prev == null ? r : Math.max(prev, r);
    prev = next;
    return next;
  });
  const tracks = smoothSeries(clamped);
  for (let i = 0; i < snapshots.length; i++) {
    snapshots[i].vehicle.track = tracks[i];
    const p = pointAlongLine(linePts, lineCum, tracks[i]);
    if (p) {
      snapshots[i].vehicle.lat = p.lat;
      snapshots[i].vehicle.lon = p.lon;
    }
  }

  const trailingPath = snapshots.map((s) => ({ lat: s.vehicle.lat, lon: s.vehicle.lon }));
  const bunch = { route: gap.route, pid: gap.pid, vehicles: [snapshots[0].vehicle] };
  const extra = [...trailingPath, { lat: stop.lat, lon: stop.lon }];
  const view = computeBunchingView(bunch, pattern, extra);
  const baseMap = await fetchBunchingBaseMap(view);

  // The trailing bus keeps the "N" (Next up) chip it carries on the still map.
  const labels = new Map();
  if (gap.trailing.vid != null) labels.set(gap.trailing.vid, 'N');
  const stopName = stop.stopName || 'the stop';

  // Lead the HUD with the full gap so "next bus ~N min" (which is only the
  // remaining half — the wait stop is the midpoint) doesn't undersell it. The
  // wait stop is named by the amber label on the map, so it's dropped here.
  const gapMin = Math.round(gap.gapMin);
  function readoutFor(track) {
    const remaining = Math.max(0, stopTrack - track);
    if (remaining <= ARRIVED_FT) return `~${gapMin}-min gap · next bus arriving`;
    const min = Math.max(1, Math.round(remaining / TYPICAL_SPEED_FT_PER_MIN));
    return `~${gapMin}-min gap · next bus ~${min} min`;
  }

  const vehicleFrames = [];
  const frameTimes = [];
  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = snapshots[i].vehicle;
    const b = snapshots[i + 1].vehicle;
    for (let k = 0; k < interpolate; k++) {
      const t = k / interpolate;
      const track = a.track + (b.track - a.track) * t;
      const p = pointAlongLine(linePts, lineCum, track);
      const lat = p ? p.lat : a.lat + (b.lat - a.lat) * t;
      const lon = p ? p.lon : a.lon + (b.lon - a.lon) * t;
      vehicleFrames.push([{ vid: a.vid, lat, lon, heading: a.heading, pdist: a.pdist, track }]);
      frameTimes.push(snapshots[i].ts + (snapshots[i + 1].ts - snapshots[i].ts) * t);
    }
  }
  const last = snapshots[snapshots.length - 1].vehicle;
  vehicleFrames.push([{ ...last }]);
  frameTimes.push(snapshots[snapshots.length - 1].ts);

  const trailFrames = Math.max(2, Math.round(TRAIL_MS / (tickMs / interpolate)));
  attachTrails(vehicleFrames, trailFrames);

  const clipStartTs = snapshots[0].ts;
  const videoEndTs = snapshots[snapshots.length - 1].ts;
  const totalSec = Math.max(1, (videoEndTs - clipStartTs) / 1000);

  const startRemaining = Math.max(0, stopTrack - snapshots[0].vehicle.track);
  const endRemaining = Math.max(0, stopTrack - last.track);
  const reached = endRemaining <= ARRIVED_FT;
  if (!reached && startRemaining - endRemaining < MIN_APPROACH_FT) return null;

  const highlightStop = { lat: stop.lat, lon: stop.lon, name: stopName };

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-bus-gap-video-'));
  try {
    for (let i = 0; i < vehicleFrames.length; i++) {
      const buf = await renderBunchingFrame(view, baseMap, vehicleFrames[i], [], [], {
        labels,
        clock: { elapsedSec: (frameTimes[i] - clipStartTs) / 1000, totalSec },
        readout: readoutFor(vehicleFrames[i][0].track),
        highlightStop,
      });
      await Fs.writeFile(Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`), buf);
    }
    const holdFrames = framerate;
    const lastIdx = vehicleFrames.length - 1;
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
      stopName: stop.stopName || null,
    };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = {
  captureBusGapVideo,
  renderBusGapClip,
  MAX_APPROACH_FT,
  MIN_APPROACH_FT,
  ARRIVED_FT,
};
