#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

const { names: routeNames, speedmap: speedmapRoutes } = require('../../src/bus/routes');
const { collect, computeSamples, pickTargetPid, binSamples, summarize } = require('../../src/bus/speedmap');
const { loadPattern } = require('../../src/bus/patterns');
const { renderSpeedmap } = require('../../src/map');
const { loginBus, postWithImage } = require('../../src/bus/bluesky');
const { pruneOldAssets } = require('../../src/shared/cleanup');
const history = require('../../src/shared/history');

const NUM_BINS = 40;
const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_DURATION_MIN = 60;

function formatTimeCT(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago',
  });
}

function buildPostText(route, pattern, summary, startTime, endTime, callouts = []) {
  const displayName = routeNames[route];
  const title = displayName ? `Route ${route} (${displayName})` : `Route ${route}`;
  const dir = pattern.direction;
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  const window = `${formatTimeCT(startTime)}–${formatTimeCT(endTime)} CT`;
  const head = `🚦 ${title} — ${dir}\n${window} · average speed ${avg}`;
  const tail = history.formatCallouts(callouts);
  return (
    (tail ? `${head}\n${tail}\n\n` : `${head}\n\n`) +
    `Each colored segment of the route shows how fast buses were moving there:\n` +
    `🟥 under 5 mph — stopped or crawling\n` +
    `🟧 5–10 mph — slow\n` +
    `🟨 10–15 mph — moderate\n` +
    `🟩 15+ mph — moving well`
  );
}

function buildAltText(route, pattern, summary) {
  const name = `${route} ${routeNames[route] || ''}`.trim();
  const dir = pattern.direction.toLowerCase();
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  return `Speedmap of the ${name} bus route ${dir} over a one-hour window, with route segments colored by average bus speed. Overall average: ${avg}. Red segments indicate stopped or crawling buses under 5 mph, orange under 10, yellow under 15, green 15 and above.`;
}

async function main() {
  pruneOldAssets();
  history.rolloffOld();
  const route = argv.route ? String(argv.route) : _.sample(speedmapRoutes);
  const durationMin = argv.duration ? Number(argv.duration) : DEFAULT_DURATION_MIN;
  const durationMs = durationMin * 60 * 1000;

  if (!routeNames[route]) {
    console.error(`Route ${route} is not a known route`);
    process.exit(1);
  }

  console.log(`Speedmap for route ${route} (${routeNames[route]}), ${durationMin}min window, poll every ${POLL_INTERVAL_MS / 1000}s`);

  const startTime = new Date();
  const tracks = await collect(route, durationMs, POLL_INTERVAL_MS);
  const endTime = new Date();

  const { byPid: samplesByPid, stats: sampleStats } = computeSamples(tracks);
  if (sampleStats.restarts > 0 || sampleStats.dropped > 0) {
    console.log(`Sample filter: ${sampleStats.restarts} pattern restart(s), ${sampleStats.dropped} out-of-range pair(s)`);
  }
  const targetPid = pickTargetPid(samplesByPid);
  if (!targetPid) {
    console.error('No speed samples collected — nothing to render');
    if (!argv['dry-run']) {
      history.recordSpeedmap({
        kind: 'bus',
        route,
        direction: null,
        avgMph: null,
        pctRed: 0, pctOrange: 0, pctYellow: 0, pctGreen: 0,
        binSpeeds: [],
        posted: false,
      });
    }
    process.exit(1);
  }

  const samples = samplesByPid.get(targetPid);
  console.log(`Target pid ${targetPid} with ${samples.length} samples across ${tracks.size} vehicles`);

  const pattern = await loadPattern(targetPid);
  const binSpeeds = binSamples(samples, pattern.lengthFt, NUM_BINS);
  const summary = summarize(binSpeeds);

  console.log(`Avg ${summary.avg?.toFixed(1)} mph · red=${summary.red} orange=${summary.orange} yellow=${summary.yellow} green=${summary.green}`);

  const callouts = history.speedmapCallouts({
    kind: 'bus',
    route,
    avgMph: summary.avg,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  const image = await renderSpeedmap(pattern, binSpeeds);
  const text = buildPostText(route, pattern, summary, startTime, endTime, callouts);
  const alt = buildAltText(route, pattern, summary);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `speedmap-${route}-${pattern.direction.toLowerCase()}-${targetPid}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginBus();
  const result = await postWithImage(agent, text, image, alt);
  const totalValid = summary.red + summary.orange + summary.yellow + summary.green;
  history.recordSpeedmap({
    kind: 'bus',
    route,
    direction: targetPid,
    avgMph: summary.avg,
    pctRed: totalValid ? summary.red / totalValid : 0,
    pctOrange: totalValid ? summary.orange / totalValid : 0,
    pctYellow: totalValid ? summary.yellow / totalValid : 0,
    pctGreen: totalValid ? summary.green / totalValid : 0,
    binSpeeds,
    posted: true,
    postUri: result.uri,
  });
  console.log(`Posted: ${result.url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
