const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getVehicles } = require('./api');
const { computeBunchingView, fetchBunchingBaseMap, renderBunchingFrame } = require('../map');
const { cumulativeDistances, haversineFt } = require('../shared/geo');

const TURNAROUND_NEAR_TERMINAL_FT = 1320; // ~0.25 mi
const TURNAROUND_GLIDE_MS = 2_500;
const TURNAROUND_HOLD_MS = 3_000;
const TURNAROUND_FADE_MS = 2_000;
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

async function captureBunchingVideo(bunch, pattern, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const signals = opts.signals || [];
  const stops = opts.stops || [];

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
    // round-trip), so both endpoints are real terminals. A drop within the
    // turnaround radius of either end is "arrived," not "lost signal."
    let turnaroundEnd = null;
    if (hasPolyline) {
      const ends = [
        { lat: pattern.points[0].lat, lon: pattern.points[0].lon },
        {
          lat: pattern.points[pattern.points.length - 1].lat,
          lon: pattern.points[pattern.points.length - 1].lon,
        },
      ];
      for (const end of ends) {
        const d = haversineFt({ lat: lsv.lat, lon: lsv.lon }, end);
        if (d <= TURNAROUND_NEAR_TERMINAL_FT) {
          turnaroundEnd = end;
          break;
        }
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
  function ghostsAt(frameTs) {
    const out = [];
    for (const [vid, drop] of tailDrops) {
      const ageMs = frameTs - drop.lastSeenTs;
      // Render at the exact transition frame (ageMs == 0) so the ghost
      // takes over without a one-frame gap; the bus is already excluded
      // from normal rendering starting at this snapshot.
      if (ageMs < 0) continue;
      if (drop.turnaroundEnd) {
        // Glide-then-glyph: lerp from last-seen position to the terminal so
        // the marker arrives gracefully, then transform into the turnaround
        // glyph for the hold + fade.
        if (ageMs < TURNAROUND_GLIDE_MS) {
          const t = ageMs / TURNAROUND_GLIDE_MS;
          out.push({
            vid,
            lat: drop.lastV.lat + (drop.turnaroundEnd.lat - drop.lastV.lat) * t,
            lon: drop.lastV.lon + (drop.turnaroundEnd.lon - drop.lastV.lon) * t,
            heading: drop.lastV.heading,
            pdist: drop.lastV.pdist,
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
          vid,
          lat: drop.turnaroundEnd.lat,
          lon: drop.turnaroundEnd.lon,
          heading: drop.lastV.heading,
          pdist: drop.lastV.pdist,
          turnaround: true,
          opacity,
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
    }
  }
  // Final real snapshot → last frame, in the same stable vid order, plus any
  // ghosts still inside their fade window at the final timestamp.
  const finalFrame = allVids.filter((vid) => finalByVid.has(vid)).map((vid) => finalByVid.get(vid));
  finalFrame.push(...ghostsAt(snapshots[lastSnapIdx].ts));
  vehicleFrames.push(finalFrame);

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-bunch-video-'));
  try {
    for (let i = 0; i < vehicleFrames.length; i++) {
      const buf = await renderBunchingFrame(view, baseMap, vehicleFrames[i], signals, stops, {
        compactStops: true,
        compactSignals: true,
        showGhostLegend: [...tailDrops.values()].some((d) => !d.turnaroundEnd),
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

module.exports = { captureBunchingVideo };
