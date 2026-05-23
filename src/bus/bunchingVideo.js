const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getVehicles } = require('./api');
const { assignBusNumbers } = require('./bunching');
const { computeBunchingView, fetchBunchingBaseMap, renderBunchingFrame } = require('../map');
const { cumulativeDistances, haversineFt } = require('../shared/geo');

const TURNAROUND_NEAR_TERMINAL_FT = 1320; // ~0.25 mi
// Glide a turned-around bus to the terminus over this many frames, then park
// the U-turn glyph there for the rest of the clip. Frames-based (not a fixed
// real-time window) because frames are ~tickMs/interpolate of real time apart,
// so a fixed-ms window compresses to ~1 frame at playback speed.
const TURNAROUND_GLIDE_FRAMES = 2;
const { smoothSeries } = require('../shared/stats');
const { snapToLine, pointAlongLine } = require('../train/speedmap');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 10 min of real time
const DEFAULT_INTERPOLATE = 4; // turns 16 real samples → 61 smoothed frames
const DEFAULT_FRAMERATE = 16; // ~4s clip at 16× speed
// CTA's getvehicles can briefly drop a vehicle (GPS loss, prediction
// suppression near terminals, single missed poll). For tail drops (vehicle
// never reappears) we render a fading gray ghost dead-reckoned along the
// polyline at last-known speed for the rest of the clip rather than letting
// the marker vanish mid-frame.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fill interior gaps where CTA dropped a vehicle for one or more polls mid-clip
// and then resumed reporting. Without this the marker freezes then jumps (a
// single missed poll) or vanishes entirely and pops back in (multi-poll gap)
// — see the route 3 #8940 ~2 min dropout. Synthesizes the missing snapshots by
// interpolating along the polyline (or straight line when no polyline) between
// the bracketing sightings so the bus glides through the gap. Only interior
// gaps are filled; a trailing gap stays a tail drop, rendered as a fading ghost
// below. Mutates `snapshots` in place; returns the number of frames filled.
function fillInteriorGaps(snapshots, { linePts, lineCum, hasPolyline }) {
  const idxByVid = new Map(); // vid → ascending [snapshotIdx] where present
  for (let s = 0; s < snapshots.length; s++) {
    for (const v of snapshots[s].vehicles) {
      if (!idxByVid.has(v.vid)) idxByVid.set(v.vid, []);
      idxByVid.get(v.vid).push(s);
    }
  }
  let filled = 0;
  for (const [vid, idxs] of idxByVid) {
    for (let p = 0; p + 1 < idxs.length; p++) {
      const ia = idxs[p];
      const ib = idxs[p + 1];
      if (ib === ia + 1) continue; // adjacent — no gap
      const va = snapshots[ia].vehicles.find((v) => v.vid === vid);
      const vb = snapshots[ib].vehicles.find((v) => v.vid === vid);
      const tA = snapshots[ia].ts;
      const tB = snapshots[ib].ts;
      for (let m = ia + 1; m < ib; m++) {
        const f = tB > tA ? (snapshots[m].ts - tA) / (tB - tA) : (m - ia) / (ib - ia);
        let lat;
        let lon;
        let track;
        if (hasPolyline && va.track != null && vb.track != null) {
          track = va.track + (vb.track - va.track) * f;
          const pt = pointAlongLine(linePts, lineCum, track);
          if (pt) {
            lat = pt.lat;
            lon = pt.lon;
          }
        }
        if (lat == null) {
          lat = va.lat + (vb.lat - va.lat) * f;
          lon = va.lon + (vb.lon - va.lon) * f;
        }
        snapshots[m].vehicles.push({
          vid,
          lat,
          lon,
          track,
          heading: va.heading,
          pdist: va.pdist,
          filled: true,
        });
        filled++;
      }
    }
  }
  return filled;
}

async function captureBunchingVideo(bunch, pattern, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const signals = opts.signals || [];
  const stops = opts.stops || [];

  const bunchVids = new Set(bunch.vehicles.map((v) => v.vid));
  const snapshots = [{ ts: Date.now(), vehicles: bunch.vehicles }];
  // vid → first sighting under a different pid. A bunched vid that reappears on
  // another pid has turned around at a terminal (CTA reassigns the trip), not
  // lost signal — the renderer uses this to show a turnaround, not a ghost.
  const turnedAround = new Map();

  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    let vehicles = [];
    const tickTs = Date.now();
    try {
      const all = await getVehicles([bunch.route], { record: false });
      for (const v of all) {
        if (
          bunchVids.has(v.vid) &&
          v.pid != null &&
          v.pid !== bunch.pid &&
          !turnedAround.has(v.vid)
        ) {
          turnedAround.set(v.vid, { ts: tickTs, vehicle: v });
        }
      }
      vehicles = all.filter((v) => v.pid === bunch.pid && bunchVids.has(v.vid));
    } catch (e) {
      console.warn(`video capture tick ${i}: fetch failed — ${e.message}`);
      continue;
    }
    if (vehicles.length === 0) {
      console.log(`video capture: all bunched buses dropped at tick ${i}, stopping`);
      break;
    }
    snapshots.push({ ts: tickTs, vehicles });
  }

  if (snapshots.length < 2) return null;

  return renderBunchingClip(snapshots, bunch, pattern, {
    tickMs,
    interpolate,
    framerate,
    signals,
    stops,
    turnedAround,
  });
}

// Attach a comet trail (recent positions, oldest → newest) to each non-parked
// vehicle in every frame, spanning up to `trailFrames` of prior frames. Pure;
// mutates frame vehicle objects by setting `.trail`. Turnaround (parked)
// markers are skipped. Exported for testing.
function attachTrails(vehicleFrames, trailFrames) {
  for (let i = 0; i < vehicleFrames.length; i++) {
    for (const veh of vehicleFrames[i]) {
      if (veh.turnaround) continue;
      const start = Math.max(0, i - trailFrames);
      const trail = [];
      for (let j = start; j <= i; j++) {
        const prev = vehicleFrames[j].find((x) => x.vid === veh.vid && !x.turnaround);
        if (prev) trail.push({ lat: prev.lat, lon: prev.lon });
      }
      if (trail.length >= 2) veh.trail = trail;
    }
  }
}

// Real-time window covered by a comet trail. Converted to a frame count via the
// per-frame real-time spacing (tickMs / interpolate).
const TRAIL_MS = 75_000;

// Assemble and encode the clip from captured (or reconstructed) snapshots.
// Split from captureBunchingVideo so it can be driven with historical data.
async function renderBunchingClip(snapshots, bunch, pattern, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const signals = opts.signals || [];
  const stops = opts.stops || [];
  const turnedAround = opts.turnedAround || new Map();

  if (snapshots.length < 2) return null;

  // Stable identity for every bunched bus, shared across all frames.
  const labels = assignBusNumbers(bunch.vehicles);

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

  fillInteriorGaps(snapshots, { linePts, lineCum, hasPolyline });

  const extraVehicles = snapshots.slice(1).flatMap((s) => s.vehicles);
  const view = computeBunchingView(bunch, pattern, extraVehicles);
  const baseMap = await fetchBunchingBaseMap(view);

  // Stable vid-sort across frames: API can return vehicles in different
  // orders each tick, which flips the perpendicular nudge in separateMarkers.
  const vehicleFrames = [];
  const frameTimes = []; // parallel to vehicleFrames: real ts of each frame
  const allVids = [...new Set(snapshots.flatMap((s) => s.vehicles.map((v) => v.vid)))].sort();

  // Tail drops: VIDs missing from the final snapshot that the API stopped
  // reporting before the clip ended. Without special handling these vanish
  // abruptly. We dead-reckon them along the polyline at last-known speed
  // and fade opacity from full to a 0.15 floor across the rest of the clip.
  const lastSnapIdx = snapshots.length - 1;
  const finalByVid = new Map(snapshots[lastSnapIdx].vehicles.map((v) => [v.vid, v]));
  const tailDrops = new Map();
  for (const vid of allVids) {
    if (finalByVid.has(vid)) continue;
    let lsi = -1;
    let lsv = null;
    for (let i = lastSnapIdx - 1; i >= 0; i--) {
      const v = snapshots[i].vehicles.find((x) => x.vid === vid);
      if (v) {
        lsi = i;
        lsv = v;
        break;
      }
    }
    if (lsi < 0) continue;
    let speedFtPerSec = 0;
    if (lsi > 0 && hasPolyline && lsv.track != null) {
      const prev = snapshots[lsi - 1].vehicles.find((x) => x.vid === vid);
      const dt = (snapshots[lsi].ts - snapshots[lsi - 1].ts) / 1000;
      if (prev && prev.track != null && dt > 0) {
        speedFtPerSec = (lsv.track - prev.track) / dt;
      }
    }
    // Terminal-arrival classifier: bus polylines are end-to-end (no Loop
    // round-trip), so both endpoints are real terminals.
    let turnaroundEnd = null;
    if (hasPolyline) {
      const ends = [
        { lat: pattern.points[0].lat, lon: pattern.points[0].lon },
        {
          lat: pattern.points[pattern.points.length - 1].lat,
          lon: pattern.points[pattern.points.length - 1].lon,
        },
      ];
      let bestEnd = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const end of ends) {
        const d = haversineFt({ lat: lsv.lat, lon: lsv.lon }, end);
        if (d < bestD) {
          bestD = d;
          bestEnd = end;
        }
      }
      // A vid that reappeared under a different pid has provably turned around
      // at a terminal — classify it as a turnaround regardless of how far short
      // of the end vertex it stopped reporting on this pattern (CTA reassigns
      // the trip before the bus crawls the final layover stretch). Otherwise
      // fall back to the proximity test against the nearer endpoint.
      if (turnedAround.has(vid) || bestD <= TURNAROUND_NEAR_TERMINAL_FT) {
        turnaroundEnd = bestEnd;
      }
    }
    tailDrops.set(vid, {
      lastSeenIdx: lsi,
      lastSeenTs: snapshots[lsi].ts,
      lastV: lsv,
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
  const turnaroundGlideMs = TURNAROUND_GLIDE_FRAMES * (tickMs / interpolate);
  function ghostsAt(frameTs) {
    const out = [];
    for (const [vid, drop] of tailDrops) {
      const ageMs = frameTs - drop.lastSeenTs;
      // Render at the exact transition frame (ageMs == 0) so the ghost
      // takes over without a one-frame gap; the bus is already excluded
      // from normal rendering starting at this snapshot.
      if (ageMs < 0) continue;
      if (drop.turnaroundEnd) {
        // Glide-then-park: lerp from last-seen position to the terminus so the
        // marker arrives gracefully, then hold the U-turn glyph parked at the
        // terminus for the rest of the clip. No fade-out — the bus has reached
        // the end and reversed, and that final state should stay readable.
        if (ageMs < turnaroundGlideMs) {
          const t = ageMs / turnaroundGlideMs;
          out.push({
            vid,
            lat: drop.lastV.lat + (drop.turnaroundEnd.lat - drop.lastV.lat) * t,
            lon: drop.lastV.lon + (drop.turnaroundEnd.lon - drop.lastV.lon) * t,
            heading: drop.lastV.heading,
            pdist: drop.lastV.pdist,
          });
          continue;
        }
        out.push({
          vid,
          lat: drop.turnaroundEnd.lat,
          lon: drop.turnaroundEnd.lon,
          heading: drop.lastV.heading,
          pdist: drop.lastV.pdist,
          turnaround: true,
        });
        continue;
      }
      const fadeMs = Math.max(1, videoEndTs - drop.lastSeenTs);
      let lat = drop.lastV.lat;
      let lon = drop.lastV.lon;
      if (hasPolyline && drop.lastV.track != null) {
        const newTrack = drop.lastV.track + drop.speedFtPerSec * (ageMs / 1000);
        const p = pointAlongLine(linePts, lineCum, newTrack);
        if (p) {
          lat = p.lat;
          lon = p.lon;
        }
      }
      const opacity = Math.max(0.15, 1 - ageMs / fadeMs);
      out.push({
        vid,
        lat,
        lon,
        heading: drop.lastV.heading,
        pdist: drop.lastV.pdist,
        ghost: true,
        opacity,
      });
    }
    return out;
  }

  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = new Map(snapshots[i].vehicles.map((v) => [v.vid, v]));
    const b = new Map(snapshots[i + 1].vehicles.map((v) => [v.vid, v]));
    // Tail-dropped VIDs render normally up to their last-seen snapshot, then
    // hand off to the fading ghost from that timestamp onward — so the bus
    // appears as usual, then turns gray and fades when the signal is lost.
    const vids = allVids.filter((vid) => {
      const drop = tailDrops.get(vid);
      if (drop && i >= drop.lastSeenIdx) return false;
      return a.has(vid) || b.has(vid);
    });
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
      const frameTs = snapshots[i].ts + (snapshots[i + 1].ts - snapshots[i].ts) * t;
      vehicles.push(...ghostsAt(frameTs));
      vehicleFrames.push(vehicles);
      frameTimes.push(frameTs);
    }
  }
  // Final real snapshot → last frame, in the same stable vid order, plus any
  // ghosts still inside their fade window at the final timestamp.
  const finalFrame = allVids.filter((vid) => finalByVid.has(vid)).map((vid) => finalByVid.get(vid));
  finalFrame.push(...ghostsAt(snapshots[lastSnapIdx].ts));
  vehicleFrames.push(finalFrame);
  frameTimes.push(videoEndTs);

  // Comet trails: recent path behind each moving bus (~TRAIL_MS of real time).
  const trailFrames = Math.max(2, Math.round(TRAIL_MS / (tickMs / interpolate)));
  attachTrails(vehicleFrames, trailFrames);

  const clipStartTs = snapshots[0].ts;
  const totalSec = Math.max(1, (videoEndTs - clipStartTs) / 1000);

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-bunch-video-'));
  try {
    for (let i = 0; i < vehicleFrames.length; i++) {
      const buf = await renderBunchingFrame(view, baseMap, vehicleFrames[i], signals, stops, {
        compactStops: true,
        compactSignals: true,
        showGhostLegend: [...tailDrops.values()].some((d) => !d.turnaroundEnd),
        labels,
        clock: { elapsedSec: (frameTimes[i] - clipStartTs) / 1000, totalSec },
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
      hadGhosts: tailDrops.size > 0,
    };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = {
  captureBunchingVideo,
  renderBunchingClip,
  fillInteriorGaps,
  attachTrails,
};
