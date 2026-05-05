#!/usr/bin/env node
// One-off: post a past bus bunching event to the bus account with the still
// image + video reply, prefixed with an explicit "this happened earlier"
// header so readers don't think it's live. Used when prod skipped the live
// post (cooldown, daily cap) but the event was significant enough to share
// after the fact.
//
// Usage:
//   node scripts/post-historical-bunch.js \
//     --pid=6662 --ts="2026-05-05 14:00:02" \
//     [--window-min=20] [--prefix="..."] [--dry-run]
//
// --ts is interpreted as UTC (matches sqlite datetime() output).
require('../src/shared/env');

const Fs = require('node:fs');
const argv = require('minimist')(process.argv.slice(2));

const { getDb } = require('../src/shared/history');
const { loadPattern, findNearestStop } = require('../src/bus/patterns');
const { detectAllBunching } = require('../src/bus/bunching');
const { renderBunchingMap } = require('../src/map');
const {
  fetchSignalsInBbox,
  filterSignalsOnRoute,
  dedupeNearbySignals,
  annotateSignalOrientations,
} = require('../src/bus/trafficSignals');
const { getPatternStops } = require('../src/bus/stops');
const { captureBunchingVideo } = require('../src/bus/bunchingVideo');
const { loginBus } = require('../src/bus/bluesky');
const { postWithImage, postWithVideo, resolveReplyRef } = require('../src/shared/bluesky');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../src/bus/bunchingPost');
const { previousMaxBunchingVehicleCount } = require('../src/shared/history');

function fmtChicago(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms));
}

function vehiclesAtTs(pid, tsMs, windowMs = 60_000) {
  const rows = getDb()
    .prepare(
      `SELECT vehicle_id, destination, lat, lon, pdist, heading, route, vehicle_ts
         FROM observations
        WHERE kind='bus' AND direction=? AND ts BETWEEN ? AND ?
        ORDER BY ts, vehicle_id`,
    )
    .all(pid, tsMs - windowMs, tsMs + windowMs);
  const byVid = new Map();
  for (const r of rows) {
    const cur = byVid.get(r.vehicle_id);
    if (!cur || Math.abs(r.vehicle_ts - tsMs) < Math.abs(cur.vehicle_ts - tsMs)) {
      byVid.set(r.vehicle_id, r);
    }
  }
  return Array.from(byVid.values()).map((r) => ({
    vid: r.vehicle_id,
    rt: r.route,
    route: r.route,
    pid,
    lat: r.lat,
    lon: r.lon,
    pdist: r.pdist,
    hdg: r.heading || 0,
    heading: r.heading || 0,
    des: r.destination,
    tmstmp: r.vehicle_ts,
  }));
}

function distinctSnapshotTsList(pid, fromMs, toMs) {
  return getDb()
    .prepare(
      `SELECT DISTINCT ts FROM observations
        WHERE kind='bus' AND direction=? AND ts BETWEEN ? AND ?
        ORDER BY ts`,
    )
    .all(pid, fromMs, toMs)
    .map((r) => r.ts);
}

async function main() {
  const pid = String(argv.pid || '');
  const tsStr = argv.ts;
  const windowMin = Number(argv['window-min'] || 20);
  const prefixOverride = argv.prefix;
  const dryRun = !!argv['dry-run'];
  if (!pid || !tsStr) {
    console.error(
      'Usage: node scripts/post-historical-bunch.js --pid=<pid> --ts="YYYY-MM-DD HH:MM:SS" [--window-min=N] [--prefix="..."] [--dry-run]',
    );
    process.exit(1);
  }
  const bunchTs = Date.parse(`${tsStr.replace(' ', 'T')}Z`);
  if (Number.isNaN(bunchTs)) {
    console.error(`Cannot parse ts: ${tsStr}`);
    process.exit(1);
  }

  const initialVehicles = vehiclesAtTs(pid, bunchTs);
  console.log(`Reconstructed ${initialVehicles.length} vehicles for pid ${pid} at ${tsStr}`);
  const bunches = detectAllBunching(initialVehicles, new Date(bunchTs));
  if (bunches.length === 0) {
    console.error('No bunch detected from the reconstructed vehicles.');
    process.exit(1);
  }
  const bunch = bunches[0];
  console.log(
    `Bunch: route ${bunch.route} pid ${bunch.pid} — ${bunch.vehicles.length} buses, span ${bunch.spanFt} ft, maxGap ${bunch.maxGapFt} ft`,
  );

  const pattern = await loadPattern(pid);
  const stop = findNearestStop(pattern, bunch.vehicles[0].pdist);
  console.log(`Anchor stop: ${stop?.stopName}`);

  // Still image (matches prod renderer exactly).
  const patternBbox = {
    minLat: Math.min(...pattern.points.map((p) => p.lat)),
    maxLat: Math.max(...pattern.points.map((p) => p.lat)),
    minLon: Math.min(...pattern.points.map((p) => p.lon)),
    maxLon: Math.max(...pattern.points.map((p) => p.lon)),
  };
  const bboxSignals = await fetchSignalsInBbox(patternBbox);
  const onRoute = filterSignalsOnRoute(bboxSignals, pattern.points);
  const signals = annotateSignalOrientations(dedupeNearbySignals(onRoute), pattern.points);
  const stops = getPatternStops(pattern);
  console.log('Rendering still image...');
  const image = await renderBunchingMap(bunch, pattern, signals, stops);

  // Build snapshots out to bunchTs + windowMin so the video shows the bunch
  // dispersing or persisting. Each distinct observation ts in the window is
  // one snapshot; observe-buses runs every 10 min so this is sparse — high
  // interpolation paints frames between them.
  const snapshotTsList = distinctSnapshotTsList(pid, bunchTs, bunchTs + windowMin * 60_000);
  const bunchVids = new Set(bunch.vehicles.map((v) => v.vid));
  const snapshots = snapshotTsList
    .map((ts) => ({
      ts,
      vehicles: vehiclesAtTs(pid, ts, 30_000).filter((v) => bunchVids.has(v.vid)),
    }))
    .filter((s) => s.vehicles.length > 0);
  console.log(
    `Snapshots for video: ${snapshots.length} across ${windowMin} min (ts: ${snapshots.map((s) => fmtChicago(s.ts)).join(', ')})`,
  );

  // High interpolate → smooth frames between sparse 10-min observations.
  // Default ticks/tickMs are ignored when snapshots are provided.
  const videoOpts = {
    snapshots,
    interpolate: 30,
    framerate: 16,
    signals,
    stops,
  };

  // Post text with explicit retroactive marker so readers don't take it as
  // live. Default prefix names the wall-clock time and minutes-ago; --prefix
  // override lets the operator phrase it differently.
  const minsAgo = Math.round((Date.now() - bunchTs) / 60_000);
  const prefix =
    prefixOverride ||
    `🕐 Reported late — happened at ${fmtChicago(bunchTs)} CT (~${minsAgo} min ago)`;
  const previousRecord = previousMaxBunchingVehicleCount('bus');
  const isAllTimeRecord = bunch.vehicles.length > previousRecord;
  if (isAllTimeRecord) {
    console.log(`🥇 new all-time record: ${bunch.vehicles.length} buses (was ${previousRecord})`);
  }
  const text = `${prefix}\n\n${buildPostText(bunch, pattern, stop, [], {
    isAllTimeRecord,
    previousRecord,
  })}`;
  const alt = buildAltText(bunch, pattern, stop);
  console.log(`\n--- POST TEXT ---\n${text}\n-----------------\n`);

  if (dryRun) {
    Fs.writeFileSync('/tmp/historical-bunch-image.jpg', image);
    console.log('Capturing video to /tmp/historical-bunch-video.mp4 ...');
    const result = await captureBunchingVideo(bunch, pattern, videoOpts);
    if (result) {
      Fs.writeFileSync('/tmp/historical-bunch-video.mp4', result.buffer);
      console.log(
        `Video: ticks=${result.ticksCaptured}, elapsed=${result.elapsedSec}s, span ${result.initialSpanFt}ft → ${result.finalSpanFt ?? '?'}ft`,
      );
      const replyText = buildVideoPostText(result, bunch, pattern);
      const replyAlt = buildVideoAltText(bunch, pattern, stop, result);
      console.log(`\n--- REPLY TEXT ---\n${replyText}\n-----------------\nReply alt: ${replyAlt}`);
    } else {
      console.log('Video capture produced <2 frames, would skip reply');
    }
    return;
  }

  const agent = await loginBus();
  const primary = await postWithImage(agent, text, image, alt);
  console.log(`Posted primary: ${primary.url}`);

  console.log('Capturing video...');
  const result = await captureBunchingVideo(bunch, pattern, videoOpts);
  if (!result) {
    console.log('Video capture produced <2 frames; skipping reply');
    return;
  }
  console.log(
    `Video: ticks=${result.ticksCaptured}, elapsed=${result.elapsedSec}s, span ${result.initialSpanFt}ft → ${result.finalSpanFt ?? '?'}ft`,
  );
  const replyRef = await resolveReplyRef(agent, primary.uri);
  const replyText = buildVideoPostText(result, bunch, pattern);
  const replyAlt = buildVideoAltText(bunch, pattern, stop, result);
  const reply = await postWithVideo(agent, replyText, result.buffer, replyAlt, replyRef);
  console.log(`Posted reply: ${reply.url}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
