const Fs = require('fs-extra');
const Os = require('os');
const Path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const { getAllTrainPositions } = require('./api');
const {
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
} = require('../map');
const { haversineFt } = require('../shared/geo');
const { smoothSeries } = require('../shared/stats');
const { buildLinePolyline, snapToLine, pointAlongLine } = require('./speedmap');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 40 × 15s = 10 min of real time
const DEFAULT_INTERPOLATE = 4;
const DEFAULT_FRAMERATE = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function trainsSpanFt(trains, linePts, lineCum) {
  if (trains.length < 2) return null;
  if (linePts && linePts.length >= 2) {
    const dists = trains.map((t) => snapToLine(t.lat, t.lon, linePts, lineCum));
    return Math.round(Math.max(...dists) - Math.min(...dists));
  }
  // Fallback when we don't have a polyline: use farthest haversine pair.
  let max = 0;
  for (let i = 0; i < trains.length; i++) {
    for (let j = i + 1; j < trains.length; j++) {
      const d = haversineFt(trains[i], trains[j]);
      if (d > max) max = d;
    }
  }
  return Math.round(max);
}

/**
 * Captures a timelapse video of a train bunching event. Mirrors the bus
 * capture: poll every `tickMs`, keep only the originally-bunched trains by rn,
 * then render all frames on a shared base map with the bbox pre-expanded to
 * cover every sampled position. Interpolates `interpolate` frames between each
 * real sample for smooth motion.
 */
async function captureTrainBunchingVideo(bunch, lineColors, trainLines, stations, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);

  const bunchRns = new Set(bunch.trains.map((t) => t.rn));
  const snapshots = [{ ts: Date.now(), trains: bunch.trains }];

  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    let trains = [];
    try {
      const all = await getAllTrainPositions([bunch.line]);
      trains = all.filter((t) => t.line === bunch.line && bunchRns.has(t.rn));
    } catch (e) {
      console.warn(`train video capture tick ${i}: fetch failed — ${e.message}`);
      continue;
    }
    if (trains.length === 0) {
      console.log(`train video capture: all bunched trains dropped at tick ${i}, stopping`);
      break;
    }
    snapshots.push({ ts: Date.now(), trains });
  }

  if (snapshots.length < 2) return null;

  // Raw CTA positions mix GPS with next-station predictions, producing two
  // artifacts the interpolator amplifies: lateral jitter off the track, and
  // occasional backwards jumps that can visually flip the order of two trains.
  // Fix both by snapping each reported position to the line polyline and then
  // clamping the along-track distance per rn to be monotonically non-decreasing.
  // Render positions are reconstructed from the clamped along-track value.
  const { points: linePts, cumDist: lineCum } = buildLinePolyline(trainLines, bunch.line);
  const hasPolyline = linePts.length >= 2;
  if (hasPolyline) {
    // Per rn: snap to line, clamp monotonically non-decreasing, then smooth
    // with a 3-tap moving average so forward GPS lurches don't make
    // tightly-bunched markers jockey between frames.
    const seriesByRn = new Map(); // rn → [{ t, raw }]
    for (const snap of snapshots) {
      for (const t of snap.trains) {
        const raw = snapToLine(t.lat, t.lon, linePts, lineCum);
        if (!seriesByRn.has(t.rn)) seriesByRn.set(t.rn, []);
        seriesByRn.get(t.rn).push({ t, raw });
      }
    }
    for (const series of seriesByRn.values()) {
      let prev = null;
      const clamped = series.map(({ raw }) => {
        const next = prev == null ? raw : Math.max(prev, raw);
        prev = next;
        return next;
      });
      const smoothed = smoothSeries(clamped);
      for (let i = 0; i < series.length; i++) {
        const { t } = series[i];
        t.track = smoothed[i];
        const snapped = pointAlongLine(linePts, lineCum, t.track);
        if (snapped) { t.lat = snapped.lat; t.lon = snapped.lon; }
      }
    }
  }

  const extraTrains = snapshots.slice(1).flatMap((s) => s.trains);
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations, extraTrains);
  const baseMap = await fetchTrainBunchingBaseMap(view);

  // Interpolate between consecutive snapshots. Stable rn ordering across
  // frames so `separateMarkers` gets a consistent input order when two
  // trains are visually overlapped — otherwise the perpendicular nudge can
  // flip sides tick-to-tick.
  const trainFrames = [];
  const allRns = [...new Set(snapshots.flatMap((s) => s.trains.map((t) => t.rn)))].sort();
  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = new Map(snapshots[i].trains.map((t) => [t.rn, t]));
    const b = new Map(snapshots[i + 1].trains.map((t) => [t.rn, t]));
    const rns = allRns.filter((rn) => a.has(rn) || b.has(rn));
    for (let k = 0; k < interpolate; k++) {
      const t = k / interpolate;
      const frame = [];
      for (const rn of rns) {
        const ta = a.get(rn);
        const tb = b.get(rn);
        const from = ta || tb;
        const to = tb || ta;
        // Interpolate along the line polyline when both endpoints have track
        // distances — Cartesian lerp cuts diagonally across curves otherwise.
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
        frame.push({
          rn,
          line: from.line,
          lat,
          lon,
          heading: from.heading,
          destination: from.destination,
          nextStation: from.nextStation,
          trDr: from.trDr,
        });
      }
      trainFrames.push(frame);
    }
  }
  const finalByRn = new Map(snapshots[snapshots.length - 1].trains.map((t) => [t.rn, t]));
  trainFrames.push(allRns.filter((rn) => finalByRn.has(rn)).map((rn) => finalByRn.get(rn)));

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-train-video-'));
  try {
    for (let i = 0; i < trainFrames.length; i++) {
      const buf = await renderTrainBunchingFrame(view, baseMap, trainFrames[i]);
      const framePath = Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`);
      await Fs.writeFile(framePath, buf);
    }
    const holdFrames = framerate;
    const lastIdx = trainFrames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(3, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      const dst = Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(3, '0')}.jpg`);
      await Fs.copyFile(lastPath, dst);
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

    const initialDistFt = Math.round(bunch.spanFt);
    const finalDistFt = trainsSpanFt(snapshots[snapshots.length - 1].trains, linePts, lineCum);
    const elapsedSec = Math.round((snapshots[snapshots.length - 1].ts - snapshots[0].ts) / 1000);

    return { buffer, ticksCaptured: snapshots.length, elapsedSec, initialDistFt, finalDistFt };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = { captureTrainBunchingVideo };
