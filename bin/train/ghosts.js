#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { LINE_NAMES, LINE_EMOJI, ALL_LINES } = require('../../src/train/api');
const { detectTrainGhosts } = require('../../src/train/ghosts');
const { buildRollupPost, POST_MAX_CHARS } = require('../../src/shared/post');

const DISCLAIMER = '"Missing" = fewer trains than the full terminal-to-terminal schedule predicts.';
const { expectedTrainHeadwayMin, expectedTrainTripMinutes, isTrainLoopLine } = require('../../src/shared/gtfs');
const { getTrainObservations, rolloffOldObservations } = require('../../src/shared/observations');
const { loginTrain, postText } = require('../../src/train/bluesky');
const { runBin } = require('../../src/shared/runBin');
const { findStationByDestination } = require('../../src/train/findStation');

const WINDOW_MS = 60 * 60 * 1000;

function formatLine(event) {
  const lineName = LINE_NAMES[event.line];
  const emoji = LINE_EMOJI[event.line];
  const missing = Math.round(event.missing);
  const expected = Math.round(event.expectedActive);
  const pct = Math.round((event.missing / event.expectedActive) * 100);
  const scheduledHeadway = Math.round(event.headway);
  const dest = event.destination ? ` → ${event.destination}` : '';
  const ratio = event.expectedActive / Math.max(event.observedActive, 1);
  if (ratio > 3) {
    return `${emoji} ${lineName} Line${dest} · ${missing} of ${expected} missing (${pct}%) · scheduled every ~${scheduledHeadway} min`;
  }
  const effectiveHeadway = Math.round(event.headway * ratio);
  return `${emoji} ${lineName} Line${dest} · ${missing} of ${expected} missing (${pct}%) · every ~${effectiveHeadway} min instead of ~${scheduledHeadway}`;
}


function buildPostText(events) {
  // Reserve the disclaimer's grapheme budget (+2 for the blank-line separator)
  // up front so buildRollupPost's truncation accounts for the footer.
  const reserved = DISCLAIMER.length + 2;
  const body = buildRollupPost('👻 Ghost trains, past hour', events.map(formatLine), POST_MAX_CHARS - reserved);
  if (!body) return null;
  return `${body}\n\n${DISCLAIMER}`;
}

async function main() {
  rolloffOldObservations();

  const now = Date.now();
  const sinceTs = now - WINDOW_MS;

  const events = await detectTrainGhosts({
    lines: ALL_LINES,
    getObservations: (line) => getTrainObservations(line, sinceTs),
    findStation: findStationByDestination,
    expectedHeadway: (line, destStation) => expectedTrainHeadwayMin(line, destStation, new Date(now)),
    expectedDuration: (line, destStation) => expectedTrainTripMinutes(line, destStation, new Date(now)),
    isLoopLine: isTrainLoopLine,
  });

  if (events.length === 0) {
    console.log('No ghost train events meet the threshold, staying silent');
    return;
  }

  for (const e of events) {
    const dirLabel = e.trDr ? `${e.trDr} (${e.destination || '?'})` : '(line-wide)';
    console.log(`  ${LINE_NAMES[e.line]} ${dirLabel}: ${e.observedActive.toFixed(1)} observed vs ${e.expectedActive.toFixed(1)} expected (${e.missing.toFixed(1)} missing across ${e.snapshots} snapshots)`);
  }

  const text = buildPostText(events);
  if (!text) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }

  if (argv['dry-run'] || process.env.GHOSTS_DRY_RUN) {
    console.log(`\n--- DRY RUN ---\n${text}`);
    return;
  }

  const agent = await loginTrain();
  const result = await postText(agent, text);
  console.log(`Posted: ${result.url}`);
}

module.exports = { formatLine };

if (require.main === module) {
  runBin(main);
}
