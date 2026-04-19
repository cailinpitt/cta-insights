#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getVehicles } = require('../../src/bus/api');
const { names: routeNames, bunching: bunchingRoutes } = require('../../src/bus/routes');
const { detectAllBunching, TERMINAL_PDIST_FT } = require('../../src/bus/bunching');
const { loadPattern } = require('../../src/bus/patterns');
const { renderBunchingMap, computeBunchingView } = require('../../src/map');
const { fetchSignalsInBbox, filterSignalsOnRoute, dedupeNearbySignals, annotateSignalOrientations } = require('../../src/bus/trafficSignals');
const { captureBunchingVideo } = require('../../src/bus/bunchingVideo');
const { loginBus, postWithImage, postWithVideo } = require('../../src/bus/bluesky');
const { isOnCooldown, acquireCooldown } = require('../../src/shared/state');
const { pruneOldAssets } = require('../../src/shared/cleanup');
const history = require('../../src/shared/history');

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

function buildPostText(bunch, pattern, stop, callouts = []) {
  const routeName = routeNames[bunch.route];
  const title = routeName ? `Route ${bunch.route} (${routeName})` : `Route ${bunch.route}`;
  const count = bunch.vehicles.length;
  const dir = pattern.direction;
  const gap = formatDistance(bunch.spanFt);
  const base = `🚌 ${title} — ${dir}\n${count} buses within ${gap} near ${stop.stopName}`;
  const tail = history.formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
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

function elapsedMinutesLabel(totalSec) {
  const m = Math.max(1, Math.round(totalSec / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

function buildVideoPostText(result) {
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  let headline;
  if (result.finalSpanFt != null) {
    const delta = result.finalSpanFt - result.initialSpanFt;
    if (delta > 50) {
      headline = `${elapsed} later, the buses were ${formatDistance(delta)} farther apart.`;
    } else if (delta < -50) {
      headline = `${elapsed} later, the gap had closed by ${formatDistance(-delta)}.`;
    } else {
      headline = `Still bunched ${elapsed} later.`;
    }
    return `${headline}\n🎬 ${formatDistance(result.initialSpanFt)} → ${formatDistance(result.finalSpanFt)}`;
  }
  return `Timelapse of the above — ${elapsed} of real time.`;
}

function buildVideoAltText(bunch, pattern, stop, result) {
  const routeName = routeNames[bunch.route];
  const title = routeName ? `Route ${bunch.route} (${routeName})` : `Route ${bunch.route}`;
  return `Timelapse map of ${title} near ${stop.stopName} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses moving over ${formatMinSec(result.elapsedSec)}.`;
}

async function main() {
  pruneOldAssets();
  history.rolloffOld();
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
    // Terminal filter first (requires pattern): terminal layovers aren't real
    // bunches and shouldn't be logged as detections at all. After that, a
    // cooldown skip means a real bunch we're suppressing — log it with
    // posted=0 so the analytics capture it.
    const candidatePattern = await loadPattern(candidate.pid);
    const firstBus = candidate.vehicles[0];
    const lastBus = candidate.vehicles[candidate.vehicles.length - 1];
    const midPdist = (firstBus.pdist + lastBus.pdist) / 2;
    const stop = findNearestStop(candidatePattern, midPdist);
    const stops = candidatePattern.points.filter((p) => p.type === 'S' && p.stopName);

    // Skip if the cluster's labeled nearest stop is the first/last stop, OR if
    // the cluster is within the terminal zone of either pattern endpoint. The
    // zone scales with route length (capped at 1500 ft) so short routes don't
    // get a zone that swallows most of the line — e.g. a 2-mi route gets
    // ~1056 ft instead of a fixed 1500 ft that would cover ~28% of it.
    const terminalZoneFt = Math.min(1500, candidatePattern.lengthFt * 0.1);
    const isAtStartTerminalStop = stop === stops[0];
    const isAtEndTerminalStop = stop === stops[stops.length - 1];
    const inStartZone = firstBus.pdist < terminalZoneFt;
    const inEndZone = candidatePattern.lengthFt - lastBus.pdist < terminalZoneFt;
    if (isAtStartTerminalStop || isAtEndTerminalStop || inStartZone || inEndZone) {
      const reason = isAtStartTerminalStop || isAtEndTerminalStop
        ? `nearest stop "${stop.stopName}" is a terminal`
        : inStartZone
          ? `within ${Math.round(terminalZoneFt)}ft of start terminal`
          : `within ${Math.round(terminalZoneFt)}ft of end terminal`;
      console.log(`  skip pid ${candidate.pid}: ${reason}`);
      continue;
    }

    // Check both pid-level and route-level cooldown. The route cooldown prevents
    // the same route from posting in opposite directions minutes apart, which
    // feels spammy even though they're technically different pids.
    const routeKey = `route:${candidate.route}`;
    if (!argv['dry-run']) {
      const pidCd = isOnCooldown(candidate.pid);
      const routeCd = isOnCooldown(routeKey);
      if (pidCd || routeCd) {
        console.log(`  skip pid ${candidate.pid}: ${pidCd ? 'pid' : 'route'} on cooldown`);
        history.recordBunching({
          kind: 'bus',
          route: candidate.route,
          direction: candidate.pid,
          vehicleCount: candidate.vehicles.length,
          severityFt: candidate.spanFt,
          nearStop: stop.stopName,
          posted: false,
        });
        continue;
      }
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

  // Compute callouts BEFORE recording this event so we don't compare against ourselves.
  const callouts = history.bunchingCallouts({
    kind: 'bus',
    route: bunch.route,
    routeLabel: `Route ${bunch.route}`,
    vehicleCount: bunch.vehicles.length,
    severityFt: bunch.spanFt,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  console.log('Rendering map...');
  // Scope the signal fetch to the full pattern bbox, not the tight still-image
  // bbox. The video reframes to cover buses as they move, so a narrow fetch
  // leaves intersections blank once the viewport drifts past them. Off-screen
  // signals are cheap to carry — renderBunchingFrame clips them at project time.
  const patternBbox = {
    minLat: Math.min(...pattern.points.map((p) => p.lat)),
    maxLat: Math.max(...pattern.points.map((p) => p.lat)),
    minLon: Math.min(...pattern.points.map((p) => p.lon)),
    maxLon: Math.max(...pattern.points.map((p) => p.lon)),
  };
  const bboxSignals = await fetchSignalsInBbox(patternBbox);
  const onRoute = filterSignalsOnRoute(bboxSignals, pattern.points);
  const signals = annotateSignalOrientations(dedupeNearbySignals(onRoute), pattern.points);
  console.log(`Signals: ${bboxSignals.length} in pattern bbox → ${onRoute.length} on route → ${signals.length} after dedupe`);
  const image = await renderBunchingMap(bunch, pattern, signals);

  const text = buildPostText(bunch, pattern, stop, callouts);
  const alt = buildAltText(bunch, pattern, stop);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `bunching-${bunch.route}-${pattern.direction.toLowerCase()}-${bunch.pid}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    if (argv.video) {
      const ticks = argv.ticks ? parseInt(argv.ticks, 10) : undefined;
      const tickMs = argv['tick-ms'] ? parseInt(argv['tick-ms'], 10) : undefined;
      const interpolate = argv.interpolate ? parseInt(argv.interpolate, 10) : undefined;
      console.log(`\nCapturing video (ticks=${ticks || 'default'}, tickMs=${tickMs || 'default'}, interpolate=${interpolate || 'default'})...`);
      const result = await captureBunchingVideo(bunch, pattern, { ticks, tickMs, interpolate, signals });
      if (!result) {
        console.log('Video capture produced <2 frames, skipped');
      } else {
        const videoPath = Path.join(__dirname, '..', 'assets', `bunching-${bunch.route}-${pattern.direction.toLowerCase()}-${bunch.pid}-${Date.now()}.mp4`);
        Fs.writeFileSync(videoPath, result.buffer);
        console.log(`Video: ${videoPath}`);
        console.log(`  ticks=${result.ticksCaptured}, elapsed=${result.elapsedSec}s, span ${result.initialSpanFt}ft → ${result.finalSpanFt ?? '?'}ft`);
      }
    }
    return;
  }

  // Final atomic cooldown acquire right before posting — closes the race
  // where two overlapping bot instances both pass the candidate-loop check
  // and would otherwise both post the same bunch.
  if (!acquireCooldown([bunch.pid, `route:${bunch.route}`])) {
    console.log('Lost cooldown race to another instance, skipping post');
    history.recordBunching({
      kind: 'bus',
      route: bunch.route,
      direction: bunch.pid,
      vehicleCount: bunch.vehicles.length,
      severityFt: bunch.spanFt,
      nearStop: stop.stopName,
      posted: false,
    });
    return;
  }

  const agent = await loginBus();
  const primary = await postWithImage(agent, text, image, alt);
  history.recordBunching({
    kind: 'bus',
    route: bunch.route,
    direction: bunch.pid,
    vehicleCount: bunch.vehicles.length,
    severityFt: bunch.spanFt,
    nearStop: stop.stopName,
    posted: true,
    postUri: primary.uri,
  });
  console.log(`Posted: ${primary.url}`);

  // Capture a timelapse of the bunch over the next few minutes and reply to
  // the primary post with it. Failures here are non-fatal: the primary alert
  // already went out, so we log and move on.
  try {
    console.log('Capturing bunching timelapse...');
    const video = await captureBunchingVideo(bunch, pattern, { signals });
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
