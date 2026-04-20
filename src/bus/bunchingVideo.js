const Fs = require('fs-extra');
const Os = require('os');
const Path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const { getVehicles } = require('./api');
const { computeBunchingView, fetchBunchingBaseMap, renderBunchingFrame } = require('../map');
const { cumulativeDistances } = require('../shared/geo');
const { smoothSeries } = require('../shared/stats');
const { snapToLine, pointAlongLine } = require('../train/speedmap');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 40 × 15s = 10 min of real time
// Interpolate this many output frames between each pair of real samples. 4×
// turns 16 real samples into 61 frames of smooth motion instead of jumps.
const DEFAULT_INTERPOLATE = 4;
// With interpolation=4, framerate=16 keeps the clip length ~4s (~16× speed).
const DEFAULT_FRAMERATE = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Captures a timelapse video of a bunching event.
 *
 * Polls the bus API every `tickMs` for `ticks` samples, keeping only the
 * vehicles that were in the original bunch (matched by vid). Frames are
 * rendered on a shared base map with a bbox expanded to cover every sampled
 * position, so the viewport is stable for the entire clip.
 *
 * Returns { buffer, ticksCaptured, elapsedSec, initialSpanFt, finalSpanFt } or
 * null if we ended up with fewer than 2 usable frames.
 */
async function captureBunchingVideo(bunch, pattern, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const signals = opts.signals || [];

  const bunchVids = new Set(bunch.vehicles.map((v) => v.vid));
  const snapshots = [{ ts: Date.now(), vehicles: bunch.vehicles }];

  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    let vehicles = [];
    try {
      const all = await getVehicles([bunch.route]);
      vehicles = all.filter((v) => v.pid === bunch.pid && bunchVids.has(v.vid));
    } catch (e) {
      console.warn(`video capture tick ${i}: fetch failed — ${e.message}`);
      continue;
    }
    if (vehicles.length === 0) {
      // All bunched buses disappeared from the feed — stop capturing.
      console.log(`video capture: all bunched buses dropped at tick ${i}, stopping`);
      break;
    }
    snapshots.push({ ts: Date.now(), vehicles });
  }

  if (snapshots.length < 2) return null;

  // Raw CTA positions have lateral GPS jitter and occasional backwards jumps
  // (prediction/GPS swaps). Three-step cleanup, applied per vid across the
  // full snapshot sequence:
  //   1. Snap each reported position onto the route pattern polyline.
  //   2. Clamp along-track distance to be monotonically non-decreasing.
  //   3. Smooth the clamped sequence with a 3-tap centered moving average so
  //      forward lurches (the clamp only removes backward ones) don't make
  //      tightly-bunched markers jockey visually frame-to-frame.
  // Same cleanup as the train video — see trainBunchingVideo.js.
  const linePts = pattern.points.map((p) => [p.lat, p.lon]);
  const lineCum = cumulativeDistances(pattern.points);
  const hasPolyline = linePts.length >= 2;
  if (hasPolyline) {
    const seriesByVid = new Map(); // vid → [{ v, raw }]
    for (const snap of snapshots) {
      for (const v of snap.vehicles) {
        const raw = snapToLine(v.lat, v.lon, linePts, lineCum);
        if (!seriesByVid.has(v.vid)) seriesByVid.set(v.vid, []);
        seriesByVid.get(v.vid).push({ v, raw });
      }
    }
    for (const series of seriesByVid.values()) {
      let prev = null;
      const clamped = series.map(({ raw }) => {
        const next = prev == null ? raw : Math.max(prev, raw);
        prev = next;
        return next;
      });
      const smoothed = smoothSeries(clamped);
      for (let i = 0; i < series.length; i++) {
        const { v } = series[i];
        v.track = smoothed[i];
        const snapped = pointAlongLine(linePts, lineCum, v.track);
        if (snapped) { v.lat = snapped.lat; v.lon = snapped.lon; }
      }
    }
  }

  const extraVehicles = snapshots.slice(1).flatMap((s) => s.vehicles);
  const view = computeBunchingView(bunch, pattern, extraVehicles);
  const baseMap = await fetchBunchingBaseMap(view);

  // Build the interpolated vehicle sequence. For each consecutive pair of real
  // samples (s[i], s[i+1]), emit `interpolate` frames lerping each vehicle's
  // position by vid. If a vehicle is missing from one side of the pair (e.g.
  // dropped from the feed mid-capture), it holds at its last known position.
  // Stable iteration order across frames: sort by vid. Without this, the API
  // can return vehicles in a different order each tick, which flips the
  // input order passed to `separateMarkers` — and when markers are tightly
  // overlapped, that flips their perpendicular nudge direction tick-to-tick.
  const vehicleFrames = [];
  const allVids = [...new Set(snapshots.flatMap((s) => s.vehicles.map((v) => v.vid)))].sort();
  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = new Map(snapshots[i].vehicles.map((v) => [v.vid, v]));
    const b = new Map(snapshots[i + 1].vehicles.map((v) => [v.vid, v]));
    const vids = allVids.filter((vid) => a.has(vid) || b.has(vid));
    for (let k = 0; k < interpolate; k++) {
      const t = k / interpolate;
      const vehicles = [];
      for (const vid of vids) {
        const va = a.get(vid);
        const vb = b.get(vid);
        const from = va || vb;
        const to = vb || va;
        // Interpolate along the pattern polyline when we have track distances
        // on both endpoints — otherwise straight-line lerp cuts diagonally
        // across turns. Fall back to Cartesian if the polyline is missing or a
        // vehicle hasn't been snapped (e.g. it was off-pattern).
        let lat, lon;
        if (hasPolyline && from.track != null && to.track != null) {
          const track = from.track + (to.track - from.track) * t;
          const p = pointAlongLine(linePts, lineCum, track);
          if (p) { lat = p.lat; lon = p.lon; }
        }
        if (lat == null) {
          lat = from.lat + (to.lat - from.lat) * t;
          lon = from.lon + (to.lon - from.lon) * t;
        }
        vehicles.push({
          vid,
          lat,
          lon,
          heading: from.heading,
          pdist: from.pdist,
        });
      }
      vehicleFrames.push(vehicles);
    }
  }
  // Always include the final real snapshot as the last interpolated frame,
  // in the same stable vid order the interpolated frames used.
  const finalByVid = new Map(snapshots[snapshots.length - 1].vehicles.map((v) => [v.vid, v]));
  vehicleFrames.push(allVids.filter((vid) => finalByVid.has(vid)).map((vid) => finalByVid.get(vid)));

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-bunch-video-'));
  try {
    for (let i = 0; i < vehicleFrames.length; i++) {
      const buf = await renderBunchingFrame(view, baseMap, vehicleFrames[i], signals);
      const framePath = Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`);
      await Fs.writeFile(framePath, buf);
    }

    // Repeat the last frame to create a ~1s hold at the end so viewers can
    // read the final state before the clip loops.
    const holdFrames = framerate;
    const lastIdx = vehicleFrames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(3, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      const dst = Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(3, '0')}.jpg`);
      await Fs.copyFile(lastPath, dst);
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
    // yuv420p requires even dims; our WIDTH/HEIGHT are even, but scale filter
    // is cheap insurance and also normalizes any base-map resize drift.
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

    const initialSpanFt = Math.round(bunch.spanFt);
    const finalVehicles = snapshots[snapshots.length - 1].vehicles;
    const finalPdists = finalVehicles.map((v) => v.pdist).filter((p) => typeof p === 'number' || !isNaN(parseFloat(p))).map((p) => parseFloat(p));
    const finalSpanFt = finalPdists.length >= 2 ? Math.round(Math.max(...finalPdists) - Math.min(...finalPdists)) : null;
    const elapsedSec = Math.round((snapshots[snapshots.length - 1].ts - snapshots[0].ts) / 1000);

    return {
      buffer,
      ticksCaptured: snapshots.length,
      elapsedSec,
      initialSpanFt,
      finalSpanFt,
    };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = { captureBunchingVideo };
