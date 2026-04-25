const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getAllTrainPositions } = require('./api');
const {
  computeSnapshotView,
  computeLoopInsetView,
  fetchSnapshotBaseLayer,
  renderSnapshotFrame,
} = require('../map');
const { buildLineBranches, snapToLineWithPerp, pointAlongLine } = require('./speedmap');
const { smoothSeries, median } = require('../shared/stats');

// Off-polyline rejection: trains whose median perp-distance to every branch
// exceeds this fall back to raw lat/lon (no snap, no monotonicity clamp).
// Generous since CTA polylines drift several hundred feet from actual track in
// places (notably Yellow and Purple's express segment).
const MAX_PERP_FT = 2000;

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 60; // 15 min of real time
const DEFAULT_INTERPOLATE = 4;
const DEFAULT_FRAMERATE = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureSnapshotVideo(initialTrains, lineColors, trainLines, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);

  const snapshots = [{ ts: Date.now(), trains: initialTrains }];

  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    try {
      const trains = await getAllTrainPositions();
      snapshots.push({ ts: Date.now(), trains });
    } catch (e) {
      console.warn(`snapshot video tick ${i}: fetch failed — ${e.message}`);
    }
  }

  if (snapshots.length < 2) return null;

  const view = computeSnapshotView(trainLines);
  const insetView = computeLoopInsetView();
  const layers = await fetchSnapshotBaseLayer(view, insetView, lineColors, trainLines);

  // Build per-line branches once so per-rn snapping is cheap.
  const branchesByLine = new Map();
  for (const line of Object.keys(trainLines)) {
    branchesByLine.set(line, buildLineBranches(trainLines, line));
  }

  // Per-rn pass: pick the best branch (lowest median perp distance), snap to
  // it, then enforce monotonicity in the direction the train is actually
  // moving (forward → non-decreasing track distance; backward → non-increasing).
  // Without this, GPS/prediction jitter shows up in the timelapse as trains
  // briefly reversing before continuing forward.
  const seriesByRn = new Map();
  for (let s = 0; s < snapshots.length; s++) {
    for (const t of snapshots[s].trains) {
      if (!seriesByRn.has(t.rn)) seriesByRn.set(t.rn, []);
      seriesByRn.get(t.rn).push({ snapIdx: s, t });
    }
  }
  for (const series of seriesByRn.values()) {
    const line = series[0].t.line;
    const branches = branchesByLine.get(line) || [];
    if (branches.length === 0) continue;

    let bestBranch = null;
    let bestMedianPerp = Infinity;
    let bestTracks = null;
    for (const br of branches) {
      const perps = [];
      const tracks = [];
      for (const { t } of series) {
        const { cumDist, perpDist } = snapToLineWithPerp(t.lat, t.lon, br.points, br.cumDist);
        perps.push(perpDist);
        tracks.push(cumDist);
      }
      const m = median(perps);
      if (m < bestMedianPerp) {
        bestMedianPerp = m;
        bestBranch = br;
        bestTracks = tracks;
      }
    }
    if (!bestBranch || bestMedianPerp > MAX_PERP_FT) continue;

    // Direction of travel along this branch: sign of (last - first). Use
    // first/last rather than per-step deltas so a single jitter step doesn't
    // flip the inferred direction.
    const direction = Math.sign(bestTracks[bestTracks.length - 1] - bestTracks[0]) || 1;
    const clamped = [];
    let prev = null;
    for (const raw of bestTracks) {
      const next = prev == null ? raw : direction >= 0 ? Math.max(prev, raw) : Math.min(prev, raw);
      prev = next;
      clamped.push(next);
    }
    // CTA's upstream feed refreshes every ~60s, but we poll every 15s, so
    // consecutive snapshots often share an identical track value. The
    // monotonic clamp above also collapses backward jitter into plateaus.
    // Both look like the train "pausing" in the timelapse. Linearly
    // interpolate across runs of equal values so motion between real
    // updates is spread evenly across the intermediate ticks.
    const deplateaued = clamped.slice();
    let i = 0;
    while (i < deplateaued.length) {
      let j = i;
      while (j + 1 < deplateaued.length && deplateaued[j + 1] === deplateaued[i]) j++;
      if (j > i && j + 1 < deplateaued.length) {
        const startVal = deplateaued[i];
        const endVal = deplateaued[j + 1];
        const span = j + 1 - i;
        for (let k = 1; k < span; k++) {
          deplateaued[i + k] = startVal + ((endVal - startVal) * k) / span;
        }
      }
      i = j + 1;
    }
    const smoothed = smoothSeries(deplateaued);
    for (let i = 0; i < series.length; i++) {
      const entry = series[i];
      entry.branch = bestBranch;
      entry.track = smoothed[i];
      const snapped = pointAlongLine(bestBranch.points, bestBranch.cumDist, entry.track);
      if (snapped) {
        // Mutate a copy so the underlying snapshot is unchanged for callers
        // that might inspect it after.
        const next = { ...entry.t, lat: snapped.lat, lon: snapped.lon };
        entry.t = next;
        snapshots[entry.snapIdx].trains = snapshots[entry.snapIdx].trains.map((tr) =>
          tr.rn === next.rn ? next : tr,
        );
      }
    }
  }

  // Interpolate between adjacent snapshots. When both endpoints share a
  // branch+track, walk the polyline so curves render correctly; otherwise
  // fall back to cartesian lerp (off-polyline trains, or trains whose snap
  // failed the perp threshold).
  const trackByRnAtSnap = new Map();
  for (const [rn, series] of seriesByRn) {
    const m = new Map();
    for (const e of series) {
      if (e.track != null && e.branch) m.set(e.snapIdx, { track: e.track, branch: e.branch });
    }
    trackByRnAtSnap.set(rn, m);
  }

  const trainFrames = [];
  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = new Map(snapshots[i].trains.map((t) => [t.rn, t]));
    const b = new Map(snapshots[i + 1].trains.map((t) => [t.rn, t]));
    const allRns = new Set([...a.keys(), ...b.keys()]);
    for (let k = 0; k < interpolate; k++) {
      const t = k / interpolate;
      const frame = [];
      for (const rn of allRns) {
        const ta = a.get(rn);
        const tb = b.get(rn);
        const from = ta || tb;
        const to = tb || ta;
        const tracks = trackByRnAtSnap.get(rn);
        const trackA = tracks?.get(i);
        const trackB = tracks?.get(i + 1);
        let lat;
        let lon;
        if (trackA && trackB && trackA.branch === trackB.branch) {
          const trackHere = trackA.track + (trackB.track - trackA.track) * t;
          const p = pointAlongLine(trackA.branch.points, trackA.branch.cumDist, trackHere);
          if (p) {
            lat = p.lat;
            lon = p.lon;
          }
        }
        if (lat == null) {
          lat = from.lat + (to.lat - from.lat) * t;
          lon = from.lon + (to.lon - from.lon) * t;
        }
        frame.push({ rn, line: from.line, lat, lon });
      }
      trainFrames.push(frame);
    }
  }
  trainFrames.push(snapshots[snapshots.length - 1].trains);

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-train-snapshot-video-'));
  try {
    for (let i = 0; i < trainFrames.length; i++) {
      const buf = await renderSnapshotFrame(layers, lineColors, trainFrames[i]);
      const framePath = Path.join(tmpDir, `frame_${String(i).padStart(4, '0')}.jpg`);
      await Fs.writeFile(framePath, buf);
    }
    // Hold last frame for one second so the final state reads before loop.
    const holdFrames = framerate;
    const lastIdx = trainFrames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(4, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      const dst = Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(4, '0')}.jpg`);
      await Fs.copyFile(lastPath, dst);
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
    const cmd = [
      'ffmpeg -y -hide_banner -loglevel error',
      `-framerate ${framerate}`,
      `-i "${Path.join(tmpDir, 'frame_%04d.jpg')}"`,
      '-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"',
      '-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart',
      `"${outPath}"`,
    ].join(' ');
    await execP(cmd, { timeout: 120_000 });
    const buffer = await Fs.readFile(outPath);

    const startTs = snapshots[0].ts;
    const endTs = snapshots[snapshots.length - 1].ts;
    const elapsedSec = Math.round((endTs - startTs) / 1000);
    const finalTrains = snapshots[snapshots.length - 1].trains;
    return { buffer, ticksCaptured: snapshots.length, elapsedSec, finalTrains, startTs, endTs };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = { captureSnapshotVideo };
