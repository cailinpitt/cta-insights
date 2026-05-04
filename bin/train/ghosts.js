#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { LINE_NAMES, LINE_EMOJI, ALL_LINES } = require('../../src/train/api');
const { detectTrainGhosts } = require('../../src/train/ghosts');
const { buildRollupThread } = require('../../src/shared/post');
const { resolveReplyRef } = require('../../src/shared/bluesky');

const DISCLAIMER = '"Missing" = fewer trains than the full terminal-to-terminal schedule predicts.';
const {
  expectedTrainHeadwayMin,
  expectedTrainTripMinutes,
  expectedTrainActiveTrips,
  isTrainLoopLine,
} = require('../../src/shared/gtfs');
const { getTrainObservations, rolloffOldObservations } = require('../../src/shared/observations');
const { loginTrain, postText } = require('../../src/train/bluesky');
const { runBin } = require('../../src/shared/runBin');
const { logDropSummary } = require('../../src/shared/ghostsLog');
const { findStationByDestination } = require('../../src/train/findStation');
const { recordMetaSignal, recordGhostEvent } = require('../../src/shared/history');
const { MISSING_ABS_THRESHOLD } = require('../../src/bus/ghosts');

const WINDOW_MS = 60 * 60 * 1000;

function formatLine(event) {
  const lineName = LINE_NAMES[event.line];
  const emoji = LINE_EMOJI[event.line];
  const missing = Math.round(event.missing);
  const expected = Math.round(event.expectedActive);
  const pct = Math.round((event.missing / event.expectedActive) * 100);
  const dest = event.destination ? ` → ${event.destination}` : '';
  if (event.headway == null) {
    return `${emoji} ${lineName} Line${dest} · ${missing} of ${expected} missing (${pct}%)`;
  }
  const scheduledHeadway = Math.round(event.headway);
  const ratio = event.expectedActive / Math.max(event.observedActive, 1);
  if (ratio > 3) {
    return `${emoji} ${lineName} Line${dest} · ${missing} of ${expected} missing (${pct}%) · scheduled every ~${scheduledHeadway} min`;
  }
  const effectiveHeadway = Math.round(event.headway * ratio);
  return `${emoji} ${lineName} Line${dest} · ${missing} of ${expected} missing (${pct}%) · every ~${effectiveHeadway} min instead of ~${scheduledHeadway}`;
}

function buildPostThread(events) {
  return buildRollupThread('👻 Ghost trains, past hour', events.map(formatLine), {
    footer: DISCLAIMER,
  });
}

async function main() {
  rolloffOldObservations();

  const now = Date.now();
  const sinceTs = now - WINDOW_MS;
  // Look up schedule at window midpoint; see bin/bus/ghosts.js for why.
  const lookupAt = new Date(now - WINDOW_MS / 2);

  const drops = [];
  const events = await detectTrainGhosts({
    lines: ALL_LINES,
    getObservations: (line) => getTrainObservations(line, sinceTs),
    findStation: findStationByDestination,
    expectedHeadway: (line, destStation) => expectedTrainHeadwayMin(line, destStation, lookupAt),
    expectedDuration: (line, destStation) => expectedTrainTripMinutes(line, destStation, lookupAt),
    expectedActive: (line, destStation) => expectedTrainActiveTrips(line, destStation, lookupAt),
    isLoopLine: isTrainLoopLine,
    onDrop: (d) => drops.push(d),
  });

  // Record sub-threshold near-miss signals for the meta-correlation roundup.
  for (const d of drops) {
    if (
      d.reason === 'below_abs_threshold' &&
      d.line &&
      d.missing != null &&
      d.missing >= MISSING_ABS_THRESHOLD * 0.5
    ) {
      recordMetaSignal({
        kind: 'train',
        line: d.line,
        direction: d.trDr || null,
        source: 'ghost',
        severity: Math.min(1, d.missing / MISSING_ABS_THRESHOLD),
        detail: { observed: d.observedActive, expected: d.expectedActive, missing: d.missing },
        posted: false,
      });
    }
  }

  if (events.length === 0) {
    console.log('No ghost train events meet the threshold, staying silent');
    logDropSummary(drops, 'train');
    return;
  }

  // Also record posted ghosts as full-strength meta_signals so roundup sees them.
  for (const e of events) {
    recordMetaSignal({
      kind: 'train',
      line: e.line,
      direction: e.trDr || null,
      source: 'ghost',
      severity: 1.0,
      detail: { observed: e.observedActive, expected: e.expectedActive, missing: e.missing },
      posted: true,
    });
  }

  for (const e of events) {
    const dirLabel = e.trDr ? `${e.trDr} (${e.destination || '?'})` : '(line-wide)';
    console.log(
      `  ${LINE_NAMES[e.line]} ${dirLabel}: ${e.observedActive.toFixed(1)} observed vs ${e.expectedActive.toFixed(1)} expected (${e.missing.toFixed(1)} missing across ${e.snapshots} snapshots)`,
    );
  }

  const posts = buildPostThread(events);
  if (!posts || posts.length === 0) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }

  if (argv['dry-run'] || process.env.GHOSTS_DRY_RUN) {
    for (let i = 0; i < posts.length; i++) {
      console.log(`\n--- DRY RUN post ${i + 1}/${posts.length} ---\n${posts[i].text}`);
    }
    return;
  }

  const agent = await loginTrain();
  let replyRef = null;
  let eventCursor = 0;
  const ts = Date.now();
  for (let i = 0; i < posts.length; i++) {
    const result = await postText(agent, posts[i].text, replyRef);
    console.log(`Posted ${i + 1}/${posts.length}: ${result.url}`);
    const slice = events.slice(eventCursor, eventCursor + posts[i].lineCount);
    for (const e of slice) {
      recordGhostEvent({
        kind: 'train',
        route: e.line,
        direction: e.destination || null,
        observed: e.observedActive,
        expected: e.expectedActive,
        missing: e.missing,
        postUri: result.uri,
        ts,
      });
    }
    eventCursor += posts[i].lineCount;
    if (i < posts.length - 1) replyRef = await resolveReplyRef(agent, result.uri);
  }
}

module.exports = { formatLine };

if (require.main === module) {
  runBin(main);
}
