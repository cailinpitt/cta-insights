#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS, LINE_NAMES } = require('../../src/train/api');
const { detectAllTrainGaps } = require('../../src/train/gaps');
const { renderTrainGap } = require('../../src/map');
const { loginTrain, postWithImage } = require('../../src/train/bluesky');
const { isOnCooldown, acquireCooldown } = require('../../src/shared/state');
const { pruneOldAssets } = require('../../src/shared/cleanup');
const { expectedTrainHeadwayMin } = require('../../src/shared/gtfs');
const history = require('../../src/shared/history');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

// Destination strings from Train Tracker don't always match trainStations.json
// verbatim (e.g. "95th/Dan Ryan" vs "95th"). Match on the train's own line so
// we don't collide on repeated station names like "Halsted" (Orange vs Blue).
function findStationByDestination(line, destination) {
  if (!destination) return null;
  const norm = destination.toLowerCase();
  const candidates = trainStations.filter((s) => s.lines?.includes(line));
  // Prefer exact match on the line.
  for (const s of candidates) {
    if (s.name.toLowerCase() === norm) return s;
  }
  // Then prefer startsWith (handles "95th" vs "95th/Dan Ryan" and parenthesized
  // line suffixes like "Halsted (Orange)").
  for (const s of candidates) {
    const baseName = s.name.toLowerCase().split(' (')[0];
    if (baseName === norm || baseName.startsWith(norm) || norm.startsWith(baseName)) return s;
  }
  // Fall back to substring.
  for (const s of candidates) {
    if (s.name.toLowerCase().includes(norm)) return s;
  }
  return null;
}

function fmtMin(m) {
  return `${Math.round(m)} min`;
}

function buildPostText(gap, callouts = []) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = gap.nearStation?.name || gap.leading.nextStation;
  const whereClause = where ? ` near ${where}` : '';
  const base = `🕳️ ${lineName} Line — to ${dest}\n${fmtMin(gap.gapMin)} gap${whereClause} — currently scheduled every ${fmtMin(gap.expectedMin)}`;
  const tail = history.formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
}

function buildAltText(gap) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = gap.nearStation?.name;
  const whereClause = where ? ` near ${where}` : '';
  return `Map of the ${lineName} Line toward ${dest} showing a ${fmtMin(gap.gapMin)} gap between trains${whereClause}.`;
}

async function main() {
  pruneOldAssets();
  history.rolloffOld();

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
  const image = await renderTrainGap(gap, LINE_COLORS, trainLines, trainStations);
  const text = buildPostText(gap, callouts);
  const alt = buildAltText(gap);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `train-gap-${LINE_NAMES[gap.line].toLowerCase()}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const dirKey = `train_gap_${gap.line}_${gap.trDr}`;
  const lineKey = `train_gap_line_${gap.line}`;
  if (!acquireCooldown([dirKey, lineKey])) {
    console.log('Lost cooldown race to another instance, skipping post');
    history.recordGap({
      kind: 'train',
      route: gap.line,
      direction: gap.trDr,
      gapFt: gap.gapFt,
      gapMin: gap.gapMin,
      expectedMin: gap.expectedMin,
      ratio: gap.ratio,
      nearStop: gap.nearStation?.name || gap.leading.nextStation,
      posted: false,
    });
    return;
  }

  const agent = await loginTrain();
  const primary = await postWithImage(agent, text, image, alt);
  history.recordGap({
    kind: 'train',
    route: gap.line,
    direction: gap.trDr,
    gapFt: gap.gapFt,
    gapMin: gap.gapMin,
    expectedMin: gap.expectedMin,
    ratio: gap.ratio,
    nearStop: gap.nearStation?.name || gap.leading.nextStation,
    posted: true,
    postUri: primary.uri,
  });
  console.log(`Posted: ${primary.url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
