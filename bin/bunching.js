#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getVehicles } = require('../src/cta');
const { names: routeNames, bunching: bunchingRoutes } = require('../src/routes');
const { detectAllBunching, TERMINAL_PDIST_FT } = require('../src/bunching');
const { loadPattern } = require('../src/patterns');
const { renderBunchingMap } = require('../src/map');
const { captureBunchingVideo } = require('../src/bunchingVideo');
const { loginBus, postWithImage, postWithVideo } = require('../src/bluesky');
const { isOnCooldown, markPosted } = require('../src/state');
const { pruneOldAssets } = require('../src/cleanup');

function findNearestStop(pattern, pdist) {
  const stops = pattern.points.filter((p) => p.type === 'S' && p.stopName);
  let best = stops[0];
  let bestDelta = Math.abs(stops[0].pdist - pdist);
  for (const s of stops) {
    const delta = Math.abs(s.pdist - pdist);
    if (delta < bestDelta) {
      best = s;
      bestDelta = delta;
    }
  }
  return best;
}

function formatDistance(ft) {
  if (ft < 1000) return `${ft} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function buildPostText(bunch, pattern, stop) {
  const routeName = routeNames[bunch.route];
  const title = routeName ? `Route ${bunch.route} (${routeName})` : `Route ${bunch.route}`;
  const count = bunch.vehicles.length;
  const dir = pattern.direction;
  const gap = formatDistance(bunch.spanFt);
  return `🚌 ${title} — ${dir}\n${count} buses within ${gap} near ${stop.stopName}`;
}

function buildAltText(bunch, pattern, stop) {
  const routeName = routeNames[bunch.route];
  const title = routeName ? `Route ${bunch.route} (${routeName})` : `Route ${bunch.route}`;
  return `Map of ${title} near ${stop.stopName} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses within ${formatDistance(bunch.spanFt)} of each other.`;
}

function formatMinSec(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildVideoPostText(result) {
  const elapsed = formatMinSec(result.elapsedSec);
  const lines = [`⏱️ Timelapse of the above — ${elapsed} of real time`];
  if (result.finalSpanFt != null) {
    const delta = result.finalSpanFt - result.initialSpanFt;
    const trend = delta > 50 ? 'pulling apart' : delta < -50 ? 'tightening' : 'holding';
    lines.push(`Spread: ${formatDistance(result.initialSpanFt)} → ${formatDistance(result.finalSpanFt)} (${trend})`);
  }
  return lines.join('\n');
}

function buildVideoAltText(bunch, pattern, stop, result) {
  const routeName = routeNames[bunch.route];
  const title = routeName ? `Route ${bunch.route} (${routeName})` : `Route ${bunch.route}`;
  return `Timelapse map of ${title} near ${stop.stopName} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses moving over ${formatMinSec(result.elapsedSec)}.`;
}

async function main() {
  pruneOldAssets();
  const routes = bunchingRoutes;
  console.log(`Fetching vehicles for ${routes.length} routes...`);
  const vehicles = await getVehicles(routes);
  console.log(`Got ${vehicles.length} vehicles`);

  const bunches = detectAllBunching(vehicles);
  if (bunches.length === 0) {
    console.log('No bunching detected');
    return;
  }

  console.log(`Found ${bunches.length} candidate bunch(es); picking best available:`);
  for (const b of bunches) {
    console.log(`  route ${b.route} pid ${b.pid} — ${b.vehicles.length} buses, span ${b.spanFt} ft, maxGap ${b.maxGapFt} ft`);
  }

  // Walk candidates best-first, skipping any that are on cooldown or whose
  // nearest-stop label is a pattern endpoint (terminal layover). The previous
  // 500 ft pdist-based check missed bunches 500-1500 ft from the terminal that
  // still labeled as "near [terminal]" because the penultimate stop is far away.
  let bunch = null;
  let pattern = null;
  let chosenStop = null;
  for (const candidate of bunches) {
    // Check both pid-level and route-level cooldown. The route cooldown prevents
    // the same route from posting in opposite directions minutes apart, which
    // feels spammy even though they're technically different pids.
    const routeKey = `route:${candidate.route}`;
    if (!argv['dry-run']) {
      if (isOnCooldown(candidate.pid)) {
        console.log(`  skip pid ${candidate.pid} (route ${candidate.route}): on cooldown`);
        continue;
      }
      if (isOnCooldown(routeKey)) {
        console.log(`  skip pid ${candidate.pid}: route ${candidate.route} is on cooldown`);
        continue;
      }
    }
    const candidatePattern = await loadPattern(candidate.pid);
    const firstBus = candidate.vehicles[0];
    const lastBus = candidate.vehicles[candidate.vehicles.length - 1];
    const midPdist = (firstBus.pdist + lastBus.pdist) / 2;
    const stop = findNearestStop(candidatePattern, midPdist);
    const stops = candidatePattern.points.filter((p) => p.type === 'S' && p.stopName);

    // Skip if the cluster's labeled nearest stop is the first/last stop, OR if
    // the cluster is within TERMINAL_ZONE_FT of either pattern endpoint. The
    // distance check catches terminal approach zones (buses queued a block or
    // two before the terminal are still terminal behavior).
    const TERMINAL_ZONE_FT = 1500;
    const isAtStartTerminalStop = stop === stops[0];
    const isAtEndTerminalStop = stop === stops[stops.length - 1];
    const inStartZone = firstBus.pdist < TERMINAL_ZONE_FT;
    const inEndZone = candidatePattern.lengthFt - lastBus.pdist < TERMINAL_ZONE_FT;
    if (isAtStartTerminalStop || isAtEndTerminalStop || inStartZone || inEndZone) {
      const reason = isAtStartTerminalStop || isAtEndTerminalStop
        ? `nearest stop "${stop.stopName}" is a terminal`
        : inStartZone
          ? `within ${TERMINAL_ZONE_FT}ft of start terminal`
          : `within ${TERMINAL_ZONE_FT}ft of end terminal`;
      console.log(`  skip pid ${candidate.pid}: ${reason}`);
      continue;
    }
    bunch = candidate;
    pattern = candidatePattern;
    chosenStop = stop;
    break;
  }

  if (!bunch) {
    console.log('All candidates filtered (cooldown or terminal layover), nothing to post');
    return;
  }

  console.log(`Posting: route ${bunch.route} pid ${bunch.pid} — ${bunch.vehicles.length} buses, ${bunch.spanFt} ft`);

  const stop = chosenStop;

  console.log('Rendering map...');
  const image = await renderBunchingMap(bunch, pattern);

  const text = buildPostText(bunch, pattern, stop);
  const alt = buildAltText(bunch, pattern, stop);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `bunching-${bunch.pid}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    if (argv.video) {
      const ticks = argv.ticks ? parseInt(argv.ticks, 10) : undefined;
      const tickMs = argv['tick-ms'] ? parseInt(argv['tick-ms'], 10) : undefined;
      const interpolate = argv.interpolate ? parseInt(argv.interpolate, 10) : undefined;
      console.log(`\nCapturing video (ticks=${ticks || 'default'}, tickMs=${tickMs || 'default'}, interpolate=${interpolate || 'default'})...`);
      const result = await captureBunchingVideo(bunch, pattern, { ticks, tickMs, interpolate });
      if (!result) {
        console.log('Video capture produced <2 frames, skipped');
      } else {
        const videoPath = Path.join(__dirname, '..', 'assets', `bunching-${bunch.pid}-${Date.now()}.mp4`);
        Fs.writeFileSync(videoPath, result.buffer);
        console.log(`Video: ${videoPath}`);
        console.log(`  ticks=${result.ticksCaptured}, elapsed=${result.elapsedSec}s, span ${result.initialSpanFt}ft → ${result.finalSpanFt ?? '?'}ft`);
      }
    }
    return;
  }

  const agent = await loginBus();
  const primary = await postWithImage(agent, text, image, alt);
  markPosted(bunch.pid);
  markPosted(`route:${bunch.route}`);
  console.log(`Posted: ${primary.url}`);

  // Capture a timelapse of the bunch over the next few minutes and reply to
  // the primary post with it. Failures here are non-fatal: the primary alert
  // already went out, so we log and move on.
  try {
    console.log('Capturing bunching timelapse...');
    const video = await captureBunchingVideo(bunch, pattern);
    if (!video) {
      console.log('Timelapse capture produced <2 frames, skipping reply');
      return;
    }
    const videoText = buildVideoPostText(video);
    const videoAlt = buildVideoAltText(bunch, pattern, stop, video);
    const replyRef = {
      root: { uri: primary.uri, cid: primary.cid },
      parent: { uri: primary.uri, cid: primary.cid },
    };
    const reply = await postWithVideo(agent, videoText, video.buffer, videoAlt, replyRef);
    console.log(`Timelapse reply: ${reply.url}`);
  } catch (e) {
    console.warn(`Timelapse reply failed: ${e.message}`);
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
