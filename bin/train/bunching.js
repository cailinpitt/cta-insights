#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS, LINE_NAMES } = require('../../src/train/api');
const { detectAllTrainBunching } = require('../../src/train/bunching');
const { renderTrainBunching } = require('../../src/map');
const { captureTrainBunchingVideo } = require('../../src/train/bunchingVideo');
const { loginTrain, postWithImage, postWithVideo, postText } = require('../../src/train/bluesky');
const { isOnCooldown } = require('../../src/shared/state');
const { commitAndPost } = require('../../src/shared/postDetection');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText } = require('../../src/train/bunchingPost');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

const TRAIN_BUNCHING_DAILY_CAP = 2;

async function main() {
  setup();

  console.log('Fetching train positions...');
  const trains = await getAllTrainPositions();
  console.log(`Got ${trains.length} trains`);

  const bunches = detectAllTrainBunching(trains, trainLines);
  if (bunches.length === 0) {
    console.log('No train bunching detected');
    return;
  }

  console.log(`Found ${bunches.length} candidate bunch(es); picking best available:`);
  for (const b of bunches) {
    console.log(`  ${LINE_NAMES[b.line]} Line toward ${b.trains[0].destination} — ${b.trains.length} trains span ${Math.round(b.spanFt)}ft, maxGap ${Math.round(b.maxGapFt)}ft`);
  }

  // Two cooldown layers, mirroring the bus bunching model:
  //   - line+direction: blocks the same direction of the same line from
  //     reposting for 1hr (same as bus `pid` cooldown — direction-specific).
  //   - line: blocks ANY direction of the same line for 1hr, so opposite
  //     directions of the Red Line don't both post back-to-back (same as
  //     bus `route:X` cooldown — direction-agnostic).
  let bunch = null;
  let dirCooldownKey = null;
  let lineCooldownKey = null;
  for (const candidate of bunches) {
    const candDirKey = `train_${candidate.line}_${candidate.trDr}`;
    const candLineKey = `train_line_${candidate.line}`;
    if (!argv['dry-run']) {
      const dirCd = isOnCooldown(candDirKey);
      const lineCd = isOnCooldown(candLineKey);
      if (dirCd || lineCd) {
        console.log(`  skip ${LINE_NAMES[candidate.line]} ${candidate.trDr}: ${dirCd ? 'direction' : 'line'} on cooldown`);
        history.recordBunching({
          kind: 'train',
          route: candidate.line,
          direction: candidate.trDr,
          vehicleCount: candidate.trains.length,
          severityFt: candidate.spanFt,
          nearStop: candidate.trains[0].nextStation,
          posted: false,
        });
        continue;
      }
      const capAllows = history.bunchingCapAllows({
        kind: 'train',
        route: candidate.line,
        candidate: { vehicleCount: candidate.trains.length, severityFt: candidate.spanFt },
        cap: TRAIN_BUNCHING_DAILY_CAP,
      });
      if (!capAllows) {
        console.log(`  skip ${LINE_NAMES[candidate.line]} ${candidate.trDr}: line at daily cap (${TRAIN_BUNCHING_DAILY_CAP}) and not more severe than today's posts`);
        history.recordBunching({
          kind: 'train',
          route: candidate.line,
          direction: candidate.trDr,
          vehicleCount: candidate.trains.length,
          severityFt: candidate.spanFt,
          nearStop: candidate.trains[0].nextStation,
          posted: false,
        });
        continue;
      }
    }
    bunch = candidate;
    dirCooldownKey = candDirKey;
    lineCooldownKey = candLineKey;
    break;
  }

  if (!bunch) {
    console.log('All candidates filtered (cooldown or daily cap), nothing to post');
    return;
  }

  console.log(`Posting: ${LINE_NAMES[bunch.line]} Line toward ${bunch.trains[0].destination} — ${bunch.trains.length} trains span ${Math.round(bunch.spanFt)}ft`);


  const callouts = history.bunchingCallouts({
    kind: 'train',
    route: bunch.line,
    routeLabel: `${LINE_NAMES[bunch.line]} Line`,
    vehicleCount: bunch.trains.length,
    severityFt: bunch.spanFt,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  console.log('Rendering map...');
  let image;
  try {
    image = await renderTrainBunching(bunch, LINE_COLORS, trainLines, trainStations);
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }
  const text = buildPostText(bunch, callouts);
  const alt = buildAltText(bunch);

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(image, `train-bunching-${LINE_NAMES[bunch.line].toLowerCase()}-${Date.now()}.jpg`);
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
        const videoPath = writeDryRunAsset(result.buffer, `train-bunching-${LINE_NAMES[bunch.line].toLowerCase()}-${Date.now()}.mp4`);
        console.log(`Video: ${videoPath}`);
        console.log(`  ticks=${result.ticksCaptured}, elapsed=${result.elapsedSec}s, gap ${result.initialDistFt}ft → ${result.finalDistFt ?? '?'}ft`);
      }
    }
    return;
  }

  const baseEvent = {
    kind: 'train',
    route: bunch.line,
    direction: bunch.trDr,
    vehicleCount: bunch.trains.length,
    severityFt: bunch.spanFt,
    nearStop: bunch.trains[0].nextStation,
  };
  const result = await commitAndPost({
    cooldownKeys: [dirCooldownKey, lineCooldownKey],
    recordSkip: () => history.recordBunching({ ...baseEvent, posted: false }),
    agentLogin: loginTrain,
    image, text, alt,
    recordPosted: (primary) => history.recordBunching({ ...baseEvent, posted: true, postUri: primary.uri }),
    postWithImage, postText,
  });
  if (!result) return;
  const { agent, primary } = result;

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

runBin(main);
