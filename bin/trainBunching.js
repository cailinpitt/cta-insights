#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS, LINE_NAMES } = require('../src/trainApi');
const { detectTrainBunching } = require('../src/trainBunching');
const { renderTrainBunching } = require('../src/map');
const { captureTrainBunchingVideo } = require('../src/trainBunchingVideo');
const { loginTrain, postWithImage, postWithVideo } = require('../src/bluesky');
const { isOnCooldown, acquireCooldown } = require('../src/shared/state');
const { pruneOldAssets } = require('../src/shared/cleanup');
const history = require('../src/shared/history');
const trainLines = require('../src/data/trainLines.json');
const trainStations = require('../src/data/trainStations.json');

function formatDistance(ft) {
  if (ft < 1000) return `${Math.round(ft)} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function buildPostText(bunch, callouts = []) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = bunch.trains[0].nextStation;
  const count = bunch.trains.length;
  const base = `🚆 ${lineName} Line — to ${dest}\n${count} trains within ${formatDistance(bunch.spanFt)} near ${station}`;
  const tail = history.formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
}

function buildAltText(bunch) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = bunch.trains[0].nextStation;
  const count = bunch.trains.length;
  return `Map of the ${lineName} Line near ${station} showing ${count} trains to ${dest} within ${formatDistance(bunch.spanFt)} of each other.`;
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
  if (result.finalDistFt != null) {
    const delta = result.finalDistFt - result.initialDistFt;
    if (delta > 50) {
      headline = `${elapsed} later, the trains were ${formatDistance(delta)} farther apart.`;
    } else if (delta < -50) {
      headline = `${elapsed} later, the gap had closed by ${formatDistance(-delta)}.`;
    } else {
      headline = `Still bunched ${elapsed} later.`;
    }
    return `${headline}\n🎬 ${formatDistance(result.initialDistFt)} → ${formatDistance(result.finalDistFt)}`;
  }
  return `Timelapse of the above — ${elapsed} of real time.`;
}

function buildVideoAltText(bunch, result) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = bunch.trains[0].nextStation;
  const count = bunch.trains.length;
  return `Timelapse map of the ${lineName} Line near ${station} showing ${count} trains to ${dest} moving over ${formatMinSec(result.elapsedSec)}.`;
}

async function main() {
  pruneOldAssets();
  history.rolloffOld();

  console.log('Fetching train positions...');
  const trains = await getAllTrainPositions();
  console.log(`Got ${trains.length} trains`);

  const bunch = detectTrainBunching(trains, trainLines);
  if (!bunch) {
    console.log('No train bunching detected');
    return;
  }

  console.log(`Bunching: ${LINE_NAMES[bunch.line]} Line toward ${bunch.trains[0].destination} — ${bunch.trains.length} trains span ${Math.round(bunch.spanFt)}ft, maxGap ${Math.round(bunch.maxGapFt)}ft`);
  console.log(`  rns: ${bunch.trains.map((t) => t.rn).join(', ')}`);

  // Two cooldown layers, mirroring the bus bunching model:
  //   - line+direction: blocks the same direction of the same line from
  //     reposting for 1hr (same as bus `pid` cooldown — direction-specific).
  //   - line: blocks ANY direction of the same line for 1hr, so opposite
  //     directions of the Red Line don't both post back-to-back (same as
  //     bus `route:X` cooldown — direction-agnostic).
  const dirCooldownKey = `train_${bunch.line}_${bunch.trDr}`;
  const lineCooldownKey = `train_line_${bunch.line}`;
  if (!argv['dry-run']) {
    const dirCd = isOnCooldown(dirCooldownKey);
    const lineCd = isOnCooldown(lineCooldownKey);
    if (dirCd || lineCd) {
      console.log(`On cooldown (${dirCd ? 'direction' : 'line'}), skipping`);
      history.recordBunching({
        kind: 'train',
        route: bunch.line,
        direction: bunch.trDr,
        vehicleCount: bunch.trains.length,
        severityFt: bunch.spanFt,
        nearStop: bunch.trains[0].nextStation,
        posted: false,
      });
      return;
    }
  }


  const callouts = history.bunchingCallouts({
    kind: 'train',
    route: bunch.line,
    routeLabel: `${LINE_NAMES[bunch.line]} Line`,
    vehicleCount: bunch.trains.length,
    severityFt: bunch.spanFt,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  console.log('Rendering map...');
  const image = await renderTrainBunching(bunch, LINE_COLORS, trainLines, trainStations);
  const text = buildPostText(bunch, callouts);
  const alt = buildAltText(bunch);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `train-bunching-${LINE_NAMES[bunch.line].toLowerCase()}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    if (argv.video) {
      const ticks = argv.ticks ? parseInt(argv.ticks, 10) : undefined;
      const tickMs = argv['tick-ms'] ? parseInt(argv['tick-ms'], 10) : undefined;
      const interpolate = argv.interpolate ? parseInt(argv.interpolate, 10) : undefined;
      console.log(`\nCapturing video (ticks=${ticks || 'default'}, tickMs=${tickMs || 'default'}, interpolate=${interpolate || 'default'})...`);
      const result = await captureTrainBunchingVideo(bunch, LINE_COLORS, trainLines, trainStations, { ticks, tickMs, interpolate });
      if (!result) {
        console.log('Video capture produced <2 frames, skipped');
      } else {
        const videoPath = Path.join(__dirname, '..', 'assets', `train-bunching-${LINE_NAMES[bunch.line].toLowerCase()}-${Date.now()}.mp4`);
        Fs.writeFileSync(videoPath, result.buffer);
        console.log(`Video: ${videoPath}`);
        console.log(`  ticks=${result.ticksCaptured}, elapsed=${result.elapsedSec}s, gap ${result.initialDistFt}ft → ${result.finalDistFt ?? '?'}ft`);
      }
    }
    return;
  }

  // Final atomic cooldown acquire right before posting — closes the race
  // where two overlapping bot instances both pass the earlier check and
  // would otherwise both post the same bunch.
  if (!acquireCooldown([dirCooldownKey, lineCooldownKey])) {
    console.log('Lost cooldown race to another instance, skipping post');
    history.recordBunching({
      kind: 'train',
      route: bunch.line,
      direction: bunch.trDr,
      vehicleCount: bunch.trains.length,
      severityFt: bunch.spanFt,
      nearStop: bunch.trains[0].nextStation,
      posted: false,
    });
    return;
  }

  const agent = await loginTrain();
  const primary = await postWithImage(agent, text, image, alt);
  history.recordBunching({
    kind: 'train',
    route: bunch.line,
    direction: bunch.trDr,
    vehicleCount: bunch.trains.length,
    severityFt: bunch.spanFt,
    nearStop: bunch.trains[0].nextStation,
    posted: true,
    postUri: primary.uri,
  });
  console.log(`Posted: ${primary.url}`);

  // Capture a timelapse and reply to the primary post. Failures are non-fatal.
  try {
    console.log('Capturing train bunching timelapse...');
    const video = await captureTrainBunchingVideo(bunch, LINE_COLORS, trainLines, trainStations);
    if (!video) {
      console.log('Timelapse capture produced <2 frames, skipping reply');
      return;
    }
    const videoText = buildVideoPostText(video);
    const videoAlt = buildVideoAltText(bunch, video);
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
