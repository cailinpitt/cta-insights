const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getAllTrainPositions } = require('./api');
const { assignTrainNumbers } = require('./bunching');
const {
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
} = require('../map');
const { haversineFt } = require('../shared/geo');
const { smoothSeries } = require('../shared/stats');
const { buildLinePolyline, snapToLine, pointAlongLine, inLoopTrunk } = require('./speedmap');

const TURNAROUND_NEAR_TERMINAL_FT = 1320; // ~0.25 mi
const TURNAROUND_GLIDE_MS = 2_500;
const TURNAROUND_HOLD_MS = 3_000;
const TURNAROUND_FADE_MS = 2_000;

// Real-terminal endpoints for a polyline: both endpoints, minus any that lie
// inside the Loop trunk. For round-trip lines (Brown/Orange/Pink/Purple)
// buildLinePolyline truncates to one direction so the inner end is the Loop
// apex, not a terminus — disappearances there are normal mid-circuit
// turnaround behavior, not "arrived at endpoint of run."
function realTerminalEnds(linePts) {
  if (!linePts || linePts.length < 2) return [];
  const toLatLon = (pt) =>
    Array.isArray(pt) ? { lat: pt[0], lon: pt[1] } : { lat: pt.lat, lon: pt.lon };
  const ends = [toLatLon(linePts[0]), toLatLon(linePts[linePts.length - 1])];
  return ends.filter(({ lat, lon }) => !inLoopTrunk(lat, lon));
}

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 10 min of real time
const DEFAULT_INTERPOLATE = 4;
const DEFAULT_FRAMERATE = 16;
// CTA's train tracker can briefly drop a train (GPS loss, prediction
// suppression near terminals/yards). For tail drops (train never reappears)
// we render a fading gray ghost dead-reckoned along the polyline at
// last-known speed for the rest of the clip rather than letting the marker
// vanish mid-frame.

// CTA occasionally returns a single-tick GPS teleport (~0.5–1 mi off-route
// and back). At ~15 s tick spacing, anything past this caps real train motion
// (top speed ~70 mph = ~1540 ft / 15 s). The bound is generous on purpose —
// real express stretches can clear ~1500 ft/tick — but cleanly rejects the
// multi-thousand-foot jumps we see in the wild.
const MAX_TRACK_STEP_FT = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polyline orientation isn't fixed per line — for some lines/branches the
// train's destination is at trackDist=0, for others at the max. We infer
// "forward" from the series' net travel, reject single-tick teleports, and
// clamp monotonic in the forward direction. A non-decreasing clamp alone
// (the prior implementation) silently accepted a glitched step in the
// polyline-forward direction even when the train was physically moving the
// other way — a single CTA GPS spike then froze the train at the bogus
// position for the remainder of the video.
function clampTrackSeries(rawSeries) {
  if (rawSeries.length === 0) return [];
  const first = rawSeries[0];
  const last = rawSeries[rawSeries.length - 1];
  const forward = last >= first ? 1 : -1;
  let prev = null;
  return rawSeries.map((raw) => {
    if (prev == null) {
      prev = raw;
      return raw;
    }
    if (Math.abs(raw - prev) > MAX_TRACK_STEP_FT) return prev;
    if ((raw - prev) * forward < 0) return prev;
    prev = raw;
    return raw;
  });
}

function trainsSpanFt(trains, linePts, lineCum) {
  if (trains.length < 2) return null;
  if (linePts && linePts.length >= 2) {
    const dists = trains.map((t) => snapToLine(t.lat, t.lon, linePts, lineCum));
    return Math.round(Math.max(...dists) - Math.min(...dists));
  }
  // No polyline → farthest haversine pair.
  let max = 0;
  for (let i = 0; i < trains.length; i++) {
    for (let j = i + 1; j < trains.length; j++) {
      const d = haversineFt(trains[i], trains[j]);
      if (d > max) max = d;
    }
  }
  return Math.round(max);
}

// Real-time window covered by a comet trail; converted to a frame count via the
// per-frame real-time spacing (tickMs / interpolate).
const TRAIL_MS = 75_000;

// Attach a comet trail (recent positions, oldest → newest) to each non-parked
// train in every frame, spanning up to `trailFrames` of prior frames. Pure;
// mutates frame train objects by setting `.trail`. Turnaround (parked) markers
// are skipped. Exported for testing.
function attachTrails(trainFrames, trailFrames) {
  for (let i = 0; i < trainFrames.length; i++) {
    for (const t of trainFrames[i]) {
      if (t.turnaround) continue;
      const start = Math.max(0, i - trailFrames);
      const trail = [];
      for (let j = start; j <= i; j++) {
        const prev = trainFrames[j].find((x) => x.rn === t.rn && !x.turnaround);
        if (prev) trail.push({ lat: prev.lat, lon: prev.lon });
      }
      if (trail.length >= 2) t.trail = trail;
    }
  }
}

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

  return renderTrainBunchingClip(snapshots, bunch, lineColors, trainLines, stations, {
    tickMs,
    interpolate,
    framerate,
  });
}

// Assemble and encode the clip from captured (or reconstructed) snapshots.
// Split from captureTrainBunchingVideo so it can be driven with historical data.
async function renderTrainBunchingClip(
  snapshots,
  bunch,
  lineColors,
  trainLines,
  stations,
  opts = {},
) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const framerate = opts.framerate || DEFAULT_FRAMERATE;

  if (snapshots.length < 2) return null;

  // Per-rn cleanup: snap to polyline → reject teleports → clamp toward
  // destination → smooth. Removes lateral jitter and backward GPS/prediction
  // swaps that would flip adjacent trains' apparent order.
  const { points: linePts, cumDist: lineCum } = buildLinePolyline(trainLines, bunch.line);
  const hasPolyline = linePts.length >= 2;
  if (hasPolyline) {
    const seriesByRn = new Map();
    for (const snap of snapshots) {
      for (const t of snap.trains) {
        const raw = snapToLine(t.lat, t.lon, linePts, lineCum);
        if (!seriesByRn.has(t.rn)) seriesByRn.set(t.rn, []);
        seriesByRn.get(t.rn).push({ t, raw });
      }
    }
    for (const series of seriesByRn.values()) {
      const clamped = clampTrackSeries(series.map((s) => s.raw));
      const smoothed = smoothSeries(clamped);
      for (let i = 0; i < series.length; i++) {
        const { t } = series[i];
        t.track = smoothed[i];
        const snapped = pointAlongLine(linePts, lineCum, t.track);
        if (snapped) {
          t.lat = snapped.lat;
          t.lon = snapped.lon;
        }
      }
    }
  }

  const extraTrains = snapshots.slice(1).flatMap((s) => s.trains);
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations, extraTrains);
  const baseMap = await fetchTrainBunchingBaseMap(view);

  // Stable identity for every bunched train, shared across all frames.
  const labels = assignTrainNumbers(bunch.trains);

  // Stable rn-sort across frames so `separateMarkers` gets consistent input
  // order — otherwise the perpendicular nudge flips for overlapped trains.
  const trainFrames = [];
  const frameTimes = []; // parallel to trainFrames: real ts of each frame
  const allRns = [...new Set(snapshots.flatMap((s) => s.trains.map((t) => t.rn)))].sort();

  // Tail drops: RNs missing from the final snapshot. Render as fading ghosts
  // (dead-reckoned along the polyline) instead of an abrupt disappearance.
  const lastSnapIdx = snapshots.length - 1;
  const finalByRn = new Map(snapshots[lastSnapIdx].trains.map((t) => [t.rn, t]));
  const tailDrops = new Map();
  for (const rn of allRns) {
    if (finalByRn.has(rn)) continue;
    let lsi = -1;
    let lst = null;
    for (let i = lastSnapIdx - 1; i >= 0; i--) {
      const t = snapshots[i].trains.find((x) => x.rn === rn);
      if (t) {
        lsi = i;
        lst = t;
        break;
      }
    }
    if (lsi < 0) continue;
    let speedFtPerSec = 0;
    if (lsi > 0 && hasPolyline && lst.track != null) {
      const prev = snapshots[lsi - 1].trains.find((x) => x.rn === rn);
      const dt = (snapshots[lsi].ts - snapshots[lsi - 1].ts) / 1000;
      if (prev && prev.track != null && dt > 0) {
        speedFtPerSec = (lst.track - prev.track) / dt;
      }
    }
    // Classify the drop: if the last-seen position was within the
    // turnaround radius of a real terminal endpoint, treat it as "arrived
    // at terminus" rather than "lost signal mid-line." Loop apex endpoints
    // are filtered out by realTerminalEnds — disappearances there stay on
    // the gray-ghost path.
    let turnaroundEnd = null;
    if (hasPolyline) {
      for (const end of realTerminalEnds(linePts)) {
        const d = haversineFt({ lat: lst.lat, lon: lst.lon }, end);
        if (d <= TURNAROUND_NEAR_TERMINAL_FT) {
          turnaroundEnd = end;
          break;
        }
      }
    }
    tailDrops.set(rn, {
      lastSeenIdx: lsi,
      lastSeenTs: snapshots[lsi].ts,
      lastT: lst,
      speedFtPerSec,
      turnaroundEnd,
    });
  }

  // Keep ghosts visible until the end of the clip, fading slowly across the
  // whole remainder. Dead-reckon position at last-known speed for the whole
  // clip too — pointAlongLine clamps at the polyline endpoints if the
  // extrapolation runs past the terminal, so a ghost just parks at the end
  // of the line rather than disappearing or jumping.
  const videoEndTs = snapshots[lastSnapIdx].ts;
  function ghostsAt(frameTs) {
    const out = [];
    for (const [rn, drop] of tailDrops) {
      const ageMs = frameTs - drop.lastSeenTs;
      // Render at the exact transition frame (ageMs == 0) so the ghost
      // takes over without a one-frame gap; the train is already excluded
      // from normal rendering starting at this snapshot.
      if (ageMs < 0) continue;
      if (drop.turnaroundEnd) {
        // Three-phase lifecycle so the marker reaches the terminal
        // gracefully instead of teleporting:
        //   [0, glide]                — normal marker, lerp from last-seen
        //                                position to the terminal
        //   [glide, glide+hold]       — turnaround glyph at full opacity
        //   [glide+hold, +fade]       — turnaround glyph fading out
        if (ageMs < TURNAROUND_GLIDE_MS) {
          const t = ageMs / TURNAROUND_GLIDE_MS;
          out.push({
            rn,
            line: drop.lastT.line,
            lat: drop.lastT.lat + (drop.turnaroundEnd.lat - drop.lastT.lat) * t,
            lon: drop.lastT.lon + (drop.turnaroundEnd.lon - drop.lastT.lon) * t,
            heading: drop.lastT.heading,
            destination: drop.lastT.destination,
            nextStation: drop.lastT.nextStation,
            trDr: drop.lastT.trDr,
          });
          continue;
        }
        const postGlideMs = ageMs - TURNAROUND_GLIDE_MS;
        if (postGlideMs > TURNAROUND_HOLD_MS + TURNAROUND_FADE_MS) continue;
        const opacity =
          postGlideMs <= TURNAROUND_HOLD_MS
            ? 1
            : Math.max(0, 1 - (postGlideMs - TURNAROUND_HOLD_MS) / TURNAROUND_FADE_MS);
        out.push({
          rn,
          line: drop.lastT.line,
          lat: drop.turnaroundEnd.lat,
          lon: drop.turnaroundEnd.lon,
          heading: drop.lastT.heading,
          destination: drop.lastT.destination,
          nextStation: drop.lastT.nextStation,
          trDr: drop.lastT.trDr,
          turnaround: true,
          opacity,
        });
        continue;
      }
      const fadeMs = Math.max(1, videoEndTs - drop.lastSeenTs);
      let lat = drop.lastT.lat;
      let lon = drop.lastT.lon;
      if (hasPolyline && drop.lastT.track != null) {
        const newTrack = drop.lastT.track + drop.speedFtPerSec * (ageMs / 1000);
        const p = pointAlongLine(linePts, lineCum, newTrack);
        if (p) {
          lat = p.lat;
          lon = p.lon;
        }
      }
      const opacity = Math.max(0.15, 1 - ageMs / fadeMs);
      out.push({
        rn,
        line: drop.lastT.line,
        lat,
        lon,
        heading: drop.lastT.heading,
        destination: drop.lastT.destination,
        nextStation: drop.lastT.nextStation,
        trDr: drop.lastT.trDr,
        ghost: true,
        opacity,
      });
    }
    return out;
  }

  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = new Map(snapshots[i].trains.map((t) => [t.rn, t]));
    const b = new Map(snapshots[i + 1].trains.map((t) => [t.rn, t]));
    // Tail-dropped RNs render normally up to their last-seen snapshot, then
    // hand off to the fading ghost so the train appears as usual before the
    // signal loss instead of materializing gray near the end.
    const rns = allRns.filter((rn) => {
      const drop = tailDrops.get(rn);
      if (drop && i >= drop.lastSeenIdx) return false;
      return a.has(rn) || b.has(rn);
    });
    for (let k = 0; k < interpolate; k++) {
      const t = k / interpolate;
      const frame = [];
      for (const rn of rns) {
        const ta = a.get(rn);
        const tb = b.get(rn);
        const from = ta || tb;
        const to = tb || ta;
        // Polyline interp when both endpoints are snapped; Cartesian fallback would cut across curves.
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
      const frameTs = snapshots[i].ts + (snapshots[i + 1].ts - snapshots[i].ts) * t;
      frame.push(...ghostsAt(frameTs));
      trainFrames.push(frame);
      frameTimes.push(frameTs);
    }
  }
  const finalFrame = allRns.filter((rn) => finalByRn.has(rn)).map((rn) => finalByRn.get(rn));
  finalFrame.push(...ghostsAt(snapshots[lastSnapIdx].ts));
  trainFrames.push(finalFrame);
  frameTimes.push(videoEndTs);

  // Comet trails: recent path behind each moving train (~TRAIL_MS of real time).
  const trailFrames = Math.max(2, Math.round(TRAIL_MS / (tickMs / interpolate)));
  attachTrails(trainFrames, trailFrames);

  const clipStartTs = snapshots[0].ts;
  const totalSec = Math.max(1, (videoEndTs - clipStartTs) / 1000);

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-train-video-'));
  try {
    for (let i = 0; i < trainFrames.length; i++) {
      const buf = await renderTrainBunchingFrame(view, baseMap, trainFrames[i], {
        showGhostLegend: [...tailDrops.values()].some((d) => !d.turnaroundEnd),
        labels,
        clock: { elapsedSec: (frameTimes[i] - clipStartTs) / 1000, totalSec },
      });
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

    return {
      buffer,
      ticksCaptured: snapshots.length,
      elapsedSec,
      initialDistFt,
      finalDistFt,
      hadGhosts: tailDrops.size > 0,
    };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = {
  captureTrainBunchingVideo,
  renderTrainBunchingClip,
  clampTrackSeries,
  MAX_TRACK_STEP_FT,
  attachTrails,
};
