#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getVehicles } = require('../../src/bus/api');
const { bunching: bunchingRoutes } = require('../../src/bus/routes');
const { detectAllBunching } = require('../../src/bus/bunching');
const { loadPattern, findNearestStop } = require('../../src/bus/patterns');
const { renderBunchingMap } = require('../../src/map');
const { fetchSignalsInBbox, filterSignalsOnRoute, dedupeNearbySignals, annotateSignalOrientations } = require('../../src/bus/trafficSignals');
const { captureBunchingVideo } = require('../../src/bus/bunchingVideo');
const { loginBus, postWithImage, postWithVideo } = require('../../src/bus/bluesky');
const { isOnCooldown, acquireCooldown } = require('../../src/shared/state');
const { terminalZoneFt: terminalZoneFor } = require('../../src/shared/geo');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText } = require('../../src/bus/bunchingPost');

async function main() {
  setup();
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
    // the cluster is within the terminal zone of either pattern endpoint.
    const terminalZoneFt = terminalZoneFor(candidatePattern.lengthFt);
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
    const outPath = writeDryRunAsset(image, `bunching-${bunch.route}-${pattern.direction.toLowerCase()}-${bunch.pid}-${Date.now()}.jpg`);
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
        const videoPath = writeDryRunAsset(result.buffer, `bunching-${bunch.route}-${pattern.direction.toLowerCase()}-${bunch.pid}-${Date.now()}.mp4`);
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

runBin(main);
