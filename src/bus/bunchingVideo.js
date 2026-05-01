const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getVehicles } = require('./api');
const { computeBunchingView, fetchBunchingBaseMap, renderBunchingFrame } = require('../map');
const { cumulativeDistances } = require('../shared/geo');
const { smoothSeries } = require('../shared/stats');
const { snapToLine, pointAlongLine } = require('../train/speedmap');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 10 min of real time
const DEFAULT_INTERPOLATE = 4; // turns 16 real samples → 61 smoothed frames
const DEFAULT_FRAMERATE = 16; // ~4s clip at 16× speed

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureBunchingVideo(bunch, pattern, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const signals = opts.signals || [];
  const stops = opts.stops || [];
  const recordBadge = opts.recordBadge === true;

  const bunchVids = new Set(bunch.vehicles.map((v) => v.vid));
  const snapshots = [{ ts: Date.now(), vehicles: bunch.vehicles }];

  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    let vehicles = [];
    try {
      const all = await getVehicles([bunch.route], { record: false });
      vehicles = all.filter((v) => v.pid === bunch.pid && bunchVids.has(v.vid));
    } catch (e) {
      console.warn(`video capture tick ${i}: fetch failed — ${e.message}`);
      continue;
    }
    if (vehicles.length === 0) {
      console.log(`video capture: all bunched buses dropped at tick ${i}, stopping`);
      break;
    }
    snapshots.push({ ts: Date.now(), vehicles });
  }

  if (snapshots.length < 2) return null;

  // Per-vid cleanup: snap to polyline → clamp non-decreasing → smooth.
  // Removes lateral GPS jitter and backward jumps (prediction/GPS swaps).
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
        if (snapped) {
          v.lat = snapped.lat;
          v.lon = snapped.lon;
        }
      }
    }
  }

  const extraVehicles = snapshots.slice(1).flatMap((s) => s.vehicles);
  const view = computeBunchingView(bunch, pattern, extraVehicles);
  const baseMap = await fetchBunchingBaseMap(view);

  // Stable vid-sort across frames: API can return vehicles in different
  // orders each tick, which flips the perpendicular nudge in separateMarkers.
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
        // Polyline interp when both endpoints are snapped; Cartesian fallback
        // (straight-line lerp would cut across turns).
        let lat, lon;
        if (hasPolyline && from.track != null && to.track != null) {
          const track = from.track + (to.track - from.track) * t;
          const p = pointAlongLine(linePts, lineCum, track);
          if (p) {
            lat = p.lat;
            lon = p.lon;
          }
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
  // Final real snapshot → last frame, in the same stable vid order.
  const finalByVid = new Map(snapshots[snapshots.length - 1].vehicles.map((v) => [v.vid, v]));
  vehicleFrames.push(
    allVids.filter((vid) => finalByVid.has(vid)).map((vid) => finalByVid.get(vid)),
  );

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-bunch-video-'));
  try {
    for (let i = 0; i < vehicleFrames.length; i++) {
      const recordBadgePhase =
        vehicleFrames.length <= 1 ? 0 : i / Math.max(1, vehicleFrames.length - 1);
      const buf = await renderBunchingFrame(view, baseMap, vehicleFrames[i], signals, stops, {
        compactStops: true,
        compactSignals: true,
        recordBadge,
        recordBadgePhase,
      });
      const framePath = Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`);
      await Fs.writeFile(framePath, buf);
    }

    // ~1s hold on the last frame so viewers can read the final state before loop.
    const holdFrames = framerate;
    const lastIdx = vehicleFrames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(3, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      const dst = Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(3, '0')}.jpg`);
      await Fs.copyFile(lastPath, dst);
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
    // yuv420p requires even dims — scale filter is cheap insurance.
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
    const finalPdists = finalVehicles
      .map((v) => v.pdist)
      .filter((p) => typeof p === 'number' || !Number.isNaN(parseFloat(p)))
      .map((p) => parseFloat(p));
    const finalSpanFt =
      finalPdists.length >= 2
        ? Math.round(Math.max(...finalPdists) - Math.min(...finalPdists))
        : null;
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
