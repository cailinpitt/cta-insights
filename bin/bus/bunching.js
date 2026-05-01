#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getVehiclesCachedOrFresh } = require('../../src/bus/api');
const { allRoutes: bunchingRoutes } = require('../../src/bus/routes');
const { detectAllBunching } = require('../../src/bus/bunching');
const { loadPattern, findNearestStop } = require('../../src/bus/patterns');
const { renderBunchingMap } = require('../../src/map');
const {
  fetchSignalsInBbox,
  filterSignalsOnRoute,
  dedupeNearbySignals,
  annotateSignalOrientations,
} = require('../../src/bus/trafficSignals');
const { getPatternStops } = require('../../src/bus/stops');
const { captureBunchingVideo } = require('../../src/bus/bunchingVideo');
const { loginBus, postWithImage, postWithVideo, postText } = require('../../src/bus/bluesky');
const { isOnCooldown } = require('../../src/shared/state');
const { commitAndPost } = require('../../src/shared/postDetection');
const { terminalZoneFt: terminalZoneFor } = require('../../src/shared/geo');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../src/bus/bunchingPost');

const BUS_BUNCHING_DAILY_CAP = 3;

async function main() {
  setup();
  const routes = bunchingRoutes;
  const { vehicles, now, source } = await getVehiclesCachedOrFresh(routes);
  console.log(
    `Got ${vehicles.length} vehicles (${source}, snapshot ${new Date(now).toISOString()})`,
  );

  const bunches = detectAllBunching(vehicles, now);
  if (bunches.length === 0) {
    console.log('No bunching detected');
    return;
  }

  console.log(`Found ${bunches.length} candidate bunch(es); picking best available:`);
  for (const b of bunches) {
    console.log(
      `  route ${b.route} pid ${b.pid} — ${b.vehicles.length} buses, span ${b.spanFt} ft, maxGap ${b.maxGapFt} ft`,
    );
  }

  let bunch = null;
  let pattern = null;
  let chosenStop = null;
  for (const candidate of bunches) {
    // Terminal layovers aren't real bunches — filter before recording, so
    // they don't pollute analytics. Cooldown skips DO record (posted=0).
    const candidatePattern = await loadPattern(candidate.pid);
    const firstBus = candidate.vehicles[0];
    const lastBus = candidate.vehicles[candidate.vehicles.length - 1];
    const midPdist = (firstBus.pdist + lastBus.pdist) / 2;
    const stop = findNearestStop(candidatePattern, midPdist);
    const stops = candidatePattern.points.filter((p) => p.type === 'S' && p.stopName);

    const terminalZoneFt = terminalZoneFor(candidatePattern.lengthFt);
    const isAtStartTerminalStop = stop === stops[0];
    const isAtEndTerminalStop = stop === stops[stops.length - 1];
    const inStartZone = firstBus.pdist < terminalZoneFt;
    const inEndZone = candidatePattern.lengthFt - lastBus.pdist < terminalZoneFt;
    if (isAtStartTerminalStop || isAtEndTerminalStop || inStartZone || inEndZone) {
      const reason =
        isAtStartTerminalStop || isAtEndTerminalStop
          ? `nearest stop "${stop.stopName}" is a terminal`
          : inStartZone
            ? `within ${Math.round(terminalZoneFt)}ft of start terminal`
            : `within ${Math.round(terminalZoneFt)}ft of end terminal`;
      console.log(`  skip pid ${candidate.pid}: ${reason}`);
      continue;
    }

    // Route-level cooldown stops opposite-direction pids from posting minutes apart.
    const routeKey = `route:${candidate.route}`;
    if (!argv['dry-run']) {
      const pidCd = isOnCooldown(candidate.pid);
      const routeCd = isOnCooldown(routeKey);
      // Pid cooldown stays strict (same direction = same incident). Route
      // cooldown allows strictly-more-severe escalations through, mirroring
      // the daily cap's dominance override.
      const routeCdOverride =
        routeCd &&
        history.bunchingCooldownAllows({
          kind: 'bus',
          route: candidate.route,
          candidate: { vehicleCount: candidate.vehicles.length, severityFt: candidate.spanFt },
        });
      if (pidCd || (routeCd && !routeCdOverride)) {
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
      if (routeCdOverride) {
        console.log(
          `  override route cooldown for pid ${candidate.pid}: ${candidate.vehicles.length} buses / ${candidate.spanFt} ft beats prior post`,
        );
      }
      const capAllows = history.bunchingCapAllows({
        kind: 'bus',
        route: candidate.route,
        candidate: { vehicleCount: candidate.vehicles.length, severityFt: candidate.spanFt },
        cap: BUS_BUNCHING_DAILY_CAP,
      });
      if (!capAllows) {
        console.log(
          `  skip pid ${candidate.pid}: route ${candidate.route} at daily cap (${BUS_BUNCHING_DAILY_CAP}) and not more severe than today's posts`,
        );
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

  console.log(
    `Posting: route ${bunch.route} pid ${bunch.pid} — ${bunch.vehicles.length} buses, ${bunch.spanFt} ft`,
  );

  const stop = chosenStop;

  // Callouts must be computed before recordBunching writes this event.
  const recordContext = history.getBusBunchingRecordContext({
    route: bunch.route,
    vehicleCount: bunch.vehicles.length,
    severityFt: bunch.spanFt,
  });
  const callouts = history.bunchingCallouts({
    kind: 'bus',
    route: bunch.route,
    routeLabel: `Route ${bunch.route}`,
    vehicleCount: bunch.vehicles.length,
    severityFt: bunch.spanFt,
    recordContext,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);
  if (recordContext.networkRecord) {
    console.log(
      `Network-wide 30-day bus bunching record: ${bunch.vehicles.length} buses / ${bunch.spanFt} ft`,
    );
  }

  console.log('Rendering map...');
  // Full-pattern bbox (vs the still-image bbox) — the video reframes as buses
  // move, so a narrow fetch leaves intersections blank when the viewport drifts.
  const patternBbox = {
    minLat: Math.min(...pattern.points.map((p) => p.lat)),
    maxLat: Math.max(...pattern.points.map((p) => p.lat)),
    minLon: Math.min(...pattern.points.map((p) => p.lon)),
    maxLon: Math.max(...pattern.points.map((p) => p.lon)),
  };
  const bboxSignals = await fetchSignalsInBbox(patternBbox);
  const onRoute = filterSignalsOnRoute(bboxSignals, pattern.points);
  const signals = annotateSignalOrientations(dedupeNearbySignals(onRoute), pattern.points);
  console.log(
    `Signals: ${bboxSignals.length} in pattern bbox → ${onRoute.length} on route → ${signals.length} after dedupe`,
  );
  const stops = getPatternStops(pattern);
  console.log(`Stops: ${stops.length} in pattern`);
  let image;
  try {
    image = await renderBunchingMap(bunch, pattern, signals, stops);
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  const text = buildPostText(bunch, pattern, stop, callouts, {
    networkRecord: recordContext.networkRecord,
  });
  const alt = buildAltText(bunch, pattern, stop, {
    networkRecord: recordContext.networkRecord,
  });

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(
      image,
      `bunching-${bunch.route}-${pattern.direction.toLowerCase()}-${bunch.pid}-${Date.now()}.jpg`,
    );
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    if (argv.video) {
      const ticks = argv.ticks ? parseInt(argv.ticks, 10) : undefined;
      const tickMs = argv['tick-ms'] ? parseInt(argv['tick-ms'], 10) : undefined;
      const interpolate = argv.interpolate ? parseInt(argv.interpolate, 10) : undefined;
      console.log(
        `\nCapturing video (ticks=${ticks || 'default'}, tickMs=${tickMs || 'default'}, interpolate=${interpolate || 'default'})...`,
      );
      const result = await captureBunchingVideo(bunch, pattern, {
        ticks,
        tickMs,
        interpolate,
        signals,
        stops,
        recordBadge: recordContext.networkRecord,
      });
      if (!result) {
        console.log('Video capture produced <2 frames, skipped');
      } else {
        const videoPath = writeDryRunAsset(
          result.buffer,
          `bunching-${bunch.route}-${pattern.direction.toLowerCase()}-${bunch.pid}-${Date.now()}.mp4`,
        );
        console.log(`Video: ${videoPath}`);
        console.log(
          `  ticks=${result.ticksCaptured}, elapsed=${result.elapsedSec}s, span ${result.initialSpanFt}ft → ${result.finalSpanFt ?? '?'}ft`,
        );
      }
    }
    return;
  }

  const baseEvent = {
    kind: 'bus',
    route: bunch.route,
    direction: bunch.pid,
    vehicleCount: bunch.vehicles.length,
    severityFt: bunch.spanFt,
    nearStop: stop.stopName,
  };
  const result = await commitAndPost({
    cooldownKeys: [bunch.pid, `route:${bunch.route}`],
    recordSkip: () => history.recordBunching({ ...baseEvent, posted: false }),
    agentLogin: loginBus,
    image,
    text,
    alt,
    recordPosted: (primary) =>
      history.recordBunching({ ...baseEvent, posted: true, postUri: primary.uri }),
    postWithImage,
    postText,
  });
  if (!result) return;
  const { agent, primary } = result;

  // Timelapse reply is non-fatal — the primary alert already went out.
  try {
    console.log('Capturing bunching timelapse...');
    const video = await captureBunchingVideo(bunch, pattern, {
      signals,
      stops,
      recordBadge: recordContext.networkRecord,
    });
    if (!video) {
      console.log('Timelapse capture produced <2 frames, skipping reply');
      return;
    }
    const videoText = buildVideoPostText(video, bunch, pattern);
    const videoAlt = buildVideoAltText(bunch, pattern, stop, video, {
      networkRecord: recordContext.networkRecord,
    });
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
