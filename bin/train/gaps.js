#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS, LINE_NAMES } = require('../../src/train/api');
const { detectAllTrainGaps } = require('../../src/train/gaps');
const { renderTrainGap } = require('../../src/map');
const { loginTrain, postWithImage, postText } = require('../../src/train/bluesky');
const { isOnCooldown } = require('../../src/shared/state');
const { commitAndPost } = require('../../src/shared/postDetection');
const { expectedTrainHeadwayMin } = require('../../src/shared/gtfs');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { buildPostText, buildAltText } = require('../../src/train/gapPost');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

// Destination strings from Train Tracker don't always match trainStations.json
// verbatim (e.g. "95th/Dan Ryan" vs "95th"). Match on the train's own line so
// we don't collide on repeated station names like "Halsted" (Orange vs Blue).
const { findStationByDestination } = require('../../src/train/findStation');

const TRAIN_GAP_DAILY_CAP = 2;

async function main() {
  setup();

  console.log('Fetching train positions...');
  const trains = await getAllTrainPositions();
  console.log(`Got ${trains.length} trains`);

  const gaps = detectAllTrainGaps(
    trains,
    trainLines,
    trainStations,
    findStationByDestination,
    (line, destStation) => expectedTrainHeadwayMin(line, destStation),
  );

  if (gaps.length === 0) {
    console.log('No significant train gaps detected');
    return;
  }

  console.log(`Found ${gaps.length} candidate gap(s); picking best available:`);
  for (const g of gaps) {
    console.log(`  ${LINE_NAMES[g.line]} ${g.trDr} — gap ${Math.round(g.gapMin)} min vs ${g.expectedMin} expected (ratio ${g.ratio.toFixed(2)})`);
  }

  let gap = null;
  for (const candidate of gaps) {
    const dirKey = `train_gap_${candidate.line}_${candidate.trDr}`;
    const lineKey = `train_gap_line_${candidate.line}`;
    if (!argv['dry-run']) {
      const dirCd = isOnCooldown(dirKey);
      const lineCd = isOnCooldown(lineKey);
      if (dirCd || lineCd) {
        console.log(`  skip ${LINE_NAMES[candidate.line]} ${candidate.trDr}: ${dirCd ? 'direction' : 'line'} on cooldown`);
        history.recordGap({
          kind: 'train',
          route: candidate.line,
          direction: candidate.trDr,
          gapFt: candidate.gapFt,
          gapMin: candidate.gapMin,
          expectedMin: candidate.expectedMin,
          ratio: candidate.ratio,
          nearStop: candidate.nearStation?.name || candidate.leading.nextStation,
          posted: false,
        });
        continue;
      }
      const capAllows = history.gapCapAllows({
        kind: 'train',
        route: candidate.line,
        candidate: { ratio: candidate.ratio },
        cap: TRAIN_GAP_DAILY_CAP,
      });
      if (!capAllows) {
        console.log(`  skip ${LINE_NAMES[candidate.line]} ${candidate.trDr}: line at daily cap (${TRAIN_GAP_DAILY_CAP}) and not more severe than today's posts`);
        history.recordGap({
          kind: 'train',
          route: candidate.line,
          direction: candidate.trDr,
          gapFt: candidate.gapFt,
          gapMin: candidate.gapMin,
          expectedMin: candidate.expectedMin,
          ratio: candidate.ratio,
          nearStop: candidate.nearStation?.name || candidate.leading.nextStation,
          posted: false,
        });
        continue;
      }
    }
    gap = candidate;
    break;
  }

  if (!gap) {
    console.log('All candidates filtered (cooldown), nothing to post');
    return;
  }

  console.log(`Posting: ${LINE_NAMES[gap.line]} Line toward ${gap.leading.destination} — ${Math.round(gap.gapMin)} min gap (${gap.ratio.toFixed(2)}x expected)`);

  const callouts = history.gapCallouts({
    kind: 'train',
    route: gap.line,
    routeLabel: `${LINE_NAMES[gap.line]} Line`,
    ratio: gap.ratio,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  console.log('Rendering map...');
  let image;
  try {
    image = await renderTrainGap(gap, LINE_COLORS, trainLines, trainStations);
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }
  const text = buildPostText(gap, callouts);
  const alt = buildAltText(gap);

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(image, `train-gap-${LINE_NAMES[gap.line].toLowerCase()}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const dirKey = `train_gap_${gap.line}_${gap.trDr}`;
  const lineKey = `train_gap_line_${gap.line}`;
  const baseEvent = {
    kind: 'train',
    route: gap.line,
    direction: gap.trDr,
    gapFt: gap.gapFt,
    gapMin: gap.gapMin,
    expectedMin: gap.expectedMin,
    ratio: gap.ratio,
    nearStop: gap.nearStation?.name || gap.leading.nextStation,
  };
  await commitAndPost({
    cooldownKeys: [dirKey, lineKey],
    recordSkip: () => history.recordGap({ ...baseEvent, posted: false }),
    agentLogin: loginTrain,
    image, text, alt,
    recordPosted: (primary) => history.recordGap({ ...baseEvent, posted: true, postUri: primary.uri }),
    postWithImage, postText,
  });
}

runBin(main);
