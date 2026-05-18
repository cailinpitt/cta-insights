#!/usr/bin/env node
// Backfill refined start/end timestamps onto historical events that the
// cron-tick cadence quantized to 5-min (roundup) or 20-min (thin-gap)
// boundaries. Only refines rows still within the retention window of
// their underlying evidence:
//   - roundup_anchors: meta_signals retention is 2d (history.js rolloff),
//     so only roundups whose ts is within the last 2d can be refined.
//   - thin-gap disruption_events: observations retention is 7d, so only
//     thin-gaps whose ts is within the last 7d can be refined.
// Older rows are skipped — the source data has rolled off.
//
// Usage:
//   node bin/backfill-event-durations.js [--dry-run]
//
// Mirrors the new live behavior in bin/incident-roundup.js and
// bin/bus/thin-gaps.js: roundup start = min(contributing meta_signal.ts);
// roundup resolved = max(meta_signal.ts in [start, original_resolved_ts]);
// thin-gap start = max(observations.ts before original ts) on the route.

require('../src/shared/env');

const Path = require('node:path');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');

const DB_PATH =
  process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');

const DAY_MS = 24 * 60 * 60 * 1000;
const ROUNDUP_WINDOW_MS = 30 * 60 * 1000; // matches incident-roundup.WINDOW_MS
const META_SIGNAL_RETENTION_MS = 2 * DAY_MS;
const OBSERVATION_RETENTION_MS = 7 * DAY_MS;

function backfillRoundupStarts(db, now) {
  const cutoff = now - META_SIGNAL_RETENTION_MS;
  const rows = db
    .prepare(`
      SELECT id, kind, line, ts
      FROM roundup_anchors
      WHERE ts >= ?
    `)
    .all(cutoff);

  const findEarliest = db.prepare(`
    SELECT MIN(ts) AS ts FROM meta_signals
    WHERE kind = ? AND line = ?
      AND ts >= ? AND ts <= ?
  `);
  const update = db.prepare('UPDATE roundup_anchors SET ts = ? WHERE id = ?');

  let touched = 0;
  let skipped = 0;
  for (const row of rows) {
    const windowStart = row.ts - ROUNDUP_WINDOW_MS;
    const r = findEarliest.get(row.kind, String(row.line), windowStart, row.ts);
    if (!r?.ts || r.ts >= row.ts) {
      skipped++;
      continue;
    }
    if (!DRY_RUN) update.run(r.ts, row.id);
    touched++;
    const deltaMin = ((row.ts - r.ts) / 60_000).toFixed(1);
    console.log(
      `roundup#${row.id} ${row.kind}/${row.line} start: ${new Date(row.ts).toISOString()} → ${new Date(r.ts).toISOString()} (−${deltaMin}m)`,
    );
  }
  console.log(
    `roundup starts: ${touched} refined, ${skipped} unchanged (of ${rows.length} within retention)`,
  );
}

function backfillRoundupResolutions(db, now) {
  const cutoff = now - META_SIGNAL_RETENTION_MS;
  // Refine resolved_ts only when the original is recent enough that
  // meta_signals from the resolution period still exist.
  const rows = db
    .prepare(`
      SELECT id, kind, line, ts, resolved_ts
      FROM roundup_anchors
      WHERE resolved_ts IS NOT NULL AND resolved_ts >= ?
    `)
    .all(cutoff);

  const findLatest = db.prepare(`
    SELECT MAX(ts) AS ts FROM meta_signals
    WHERE kind = ? AND line = ?
      AND ts >= ? AND ts <= ?
  `);
  const update = db.prepare('UPDATE roundup_anchors SET resolved_ts = ? WHERE id = ?');

  let touched = 0;
  let skipped = 0;
  for (const row of rows) {
    // Live sweepResolutions uses signals from a 30-min lookback off the
    // first-quiet cron tick. Mirror that here so the refinement matches
    // what live would have stamped: scan only the trailing 30 min before
    // the original resolved_ts.
    const lookbackStart = Math.max(row.ts, row.resolved_ts - ROUNDUP_WINDOW_MS);
    const r = findLatest.get(row.kind, String(row.line), lookbackStart, row.resolved_ts);
    // Require the refined ts to sit strictly between start and original
    // resolution. If no signal exists in that span (e.g. it went truly
    // quiet right after firing), leave the original — we don't want to
    // collapse the duration to zero.
    if (!r?.ts || r.ts <= row.ts || r.ts >= row.resolved_ts) {
      skipped++;
      continue;
    }
    if (!DRY_RUN) update.run(r.ts, row.id);
    touched++;
    const deltaMin = ((row.resolved_ts - r.ts) / 60_000).toFixed(1);
    console.log(
      `roundup#${row.id} ${row.kind}/${row.line} resolved: ${new Date(row.resolved_ts).toISOString()} → ${new Date(r.ts).toISOString()} (−${deltaMin}m)`,
    );
  }
  console.log(
    `roundup resolutions: ${touched} refined, ${skipped} unchanged (of ${rows.length} within retention)`,
  );
}

function backfillThinGapStarts(db, now) {
  const cutoff = now - OBSERVATION_RETENTION_MS;
  const rows = db
    .prepare(`
      SELECT id, line, ts
      FROM disruption_events
      WHERE source = 'observed-thin' AND kind = 'bus' AND ts >= ?
    `)
    .all(cutoff);

  const findLastObs = db.prepare(`
    SELECT MAX(ts) AS ts FROM observations
    WHERE kind = 'bus' AND route = ? AND ts < ?
  `);
  const update = db.prepare('UPDATE disruption_events SET ts = ? WHERE id = ?');

  let touched = 0;
  let skipped = 0;
  for (const row of rows) {
    const r = findLastObs.get(String(row.line), row.ts);
    if (!r?.ts || r.ts >= row.ts) {
      skipped++;
      continue;
    }
    // Don't push the start before the matching observed-clear's ts on the
    // same route — that would invert duration. Also a sanity floor.
    if (!DRY_RUN) update.run(r.ts, row.id);
    touched++;
    const deltaMin = ((row.ts - r.ts) / 60_000).toFixed(1);
    console.log(
      `thin-gap#${row.id} bus/${row.line} start: ${new Date(row.ts).toISOString()} → ${new Date(r.ts).toISOString()} (−${deltaMin}m)`,
    );
  }
  console.log(
    `thin-gap starts: ${touched} refined, ${skipped} unchanged (of ${rows.length} within retention)`,
  );
}

function main() {
  const db = new Database(DB_PATH);
  if (DRY_RUN) {
    console.log('=== DRY RUN — no writes ===');
  } else {
    console.log(`writing to ${DB_PATH}`);
  }
  const now = Date.now();

  // Wrap in a single transaction so a mid-run crash leaves the DB
  // unchanged. Live writers will block briefly during execution — runtime
  // should be sub-second on a few hundred rows.
  const tx = db.transaction(() => {
    backfillRoundupStarts(db, now);
    backfillRoundupResolutions(db, now);
    backfillThinGapStarts(db, now);
  });
  tx();

  db.close();
}

main();
