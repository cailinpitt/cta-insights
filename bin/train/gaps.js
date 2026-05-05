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
const {
  recentPulseOnLine,
  recentGhostOnLine,
  chicagoStartOfRushPeriod,
  recordMetaSignal,
} = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { buildPostText, buildAltText } = require('../../src/train/gapPost');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

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
    console.log(
      `  ${LINE_NAMES[g.line]} ${g.trDr} — gap ${Math.round(g.gapMin)} min vs ${g.expectedMin} expected (ratio ${g.ratio.toFixed(2)})`,
    );
  }

  let gap = null;
  // Set when the chosen candidate broke through an active cooldown via the
  // severity-margin gate (see commitAndPost for why this matters).
  let cooldownOverridden = false;
  for (const candidate of gaps) {
    const dirKey = `train_gap_${candidate.line}_${candidate.trDr}`;
    const lineKey = `train_gap_line_${candidate.line}`;
    if (!argv['dry-run']) {
      const dirCd = isOnCooldown(dirKey);
      const lineCd = isOnCooldown(lineKey);
      // Both direction and line cooldown allow strictly-more-severe
      // escalations through (1.25× ratio margin) — mirrors the bunching
      // path. Without the margin, ratios would flap on the same incident
      // because schedule-derived expectedMin drifts.
      const cooldownAllows = history.gapCooldownAllows({
        kind: 'train',
        route: candidate.line,
        candidate: { ratio: candidate.ratio },
      });
      const dirCdOverride = dirCd && cooldownAllows;
      const lineCdOverride = lineCd && cooldownAllows;
      if ((dirCd && !dirCdOverride) || (lineCd && !lineCdOverride)) {
        const which = dirCd && !dirCdOverride ? 'direction' : 'line';
        console.log(`  skip ${LINE_NAMES[candidate.line]} ${candidate.trDr}: ${which} on cooldown`);
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
        recordMetaSignal({
          kind: 'train',
          line: candidate.line,
          direction: candidate.trDr,
          source: 'gap',
          severity: Math.min(1, candidate.ratio / 4),
          detail: { ratio: candidate.ratio, suppressed: 'cooldown' },
          posted: false,
        });
        continue;
      }
      if (dirCdOverride || lineCdOverride) {
        const which = dirCdOverride ? 'direction' : 'line';
        console.log(
          `  override ${which} cooldown for ${LINE_NAMES[candidate.line]} ${candidate.trDr}: ${candidate.ratio.toFixed(2)}× beats prior post by ≥1.25× margin`,
        );
        cooldownOverridden = true;
      }
      const capAllows = history.gapCapAllows({
        kind: 'train',
        route: candidate.line,
        candidate: { ratio: candidate.ratio },
        cap: TRAIN_GAP_DAILY_CAP,
        windowStartTs: chicagoStartOfRushPeriod(Date.now()),
      });
      let capExemption = null;
      if (!capAllows) {
        const recentPulse = recentPulseOnLine({
          kind: 'train',
          line: candidate.line,
          withinMs: 30 * 60 * 1000,
        });
        const recentGhost = recentGhostOnLine({
          kind: 'train',
          line: candidate.line,
          withinMs: 90 * 60 * 1000,
        });
        if (recentPulse) {
          capExemption = `recent pulse@${Math.round((Date.now() - recentPulse.ts) / 60000)}m`;
        } else if (recentGhost) {
          capExemption = `recent ghost@${Math.round((Date.now() - recentGhost.ts) / 60000)}m`;
        }
      }
      if (!capAllows && !capExemption) {
        console.log(
          `  skip ${LINE_NAMES[candidate.line]} ${candidate.trDr}: line at rush-period cap (${TRAIN_GAP_DAILY_CAP}) and not more severe than this period's posts`,
        );
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
        recordMetaSignal({
          kind: 'train',
          line: candidate.line,
          direction: candidate.trDr,
          source: 'gap',
          severity: Math.min(1, candidate.ratio / 4),
          detail: { ratio: candidate.ratio, suppressed: 'cap' },
          posted: false,
        });
        continue;
      }
      if (capExemption) {
        console.log(
          `  cap-exempt ${LINE_NAMES[candidate.line]} ${candidate.trDr}: ${capExemption}`,
        );
      }
    }
    gap = candidate;
    break;
  }

  if (!gap) {
    console.log('All candidates filtered (cooldown), nothing to post');
    return;
  }

  console.log(
    `Posting: ${LINE_NAMES[gap.line]} Line toward ${gap.leading.destination} — ${Math.round(gap.gapMin)} min gap (${gap.ratio.toFixed(2)}x expected)`,
  );

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
    const outPath = writeDryRunAsset(
      image,
      `train-gap-${LINE_NAMES[gap.line].toLowerCase()}-${Date.now()}.jpg`,
    );
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
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => history.recordGap({ ...baseEvent, posted: false }),
    agentLogin: loginTrain,
    image,
    text,
    alt,
    recordPosted: (primary) =>
      history.recordGap({ ...baseEvent, posted: true, postUri: primary.uri }),
    postWithImage,
    postText,
  });
}

runBin(main);
