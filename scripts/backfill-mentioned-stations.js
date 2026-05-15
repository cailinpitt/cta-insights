#!/usr/bin/env node
// One-off backfill: populate alert_posts.mentioned_stations for existing
// train alerts whose ingest predates the extractor. Re-runs
// extractMentionedStations against the stored headline + short_description.
// Idempotent — only updates rows where mentioned_stations IS NULL, so
// re-running won't clobber values already written by the live ingest.
//
// Bus alerts are intentionally skipped (out of scope: bus-stop roster is a
// different problem). Multi-line alerts are skipped to mirror the live ingest
// (extractor is line-scoped, ambiguous on multi-line).

require('../src/shared/env');
const Database = require('better-sqlite3');
const { extractMentionedStations } = require('../src/shared/ctaAlerts');

const DB_PATH =
  process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';
const DRY_RUN = process.argv.includes('--dry-run');

function main() {
  const db = new Database(DB_PATH);
  const rows = db
    .prepare(
      `SELECT alert_id, routes, headline, short_description
       FROM alert_posts
       WHERE kind = 'train' AND mentioned_stations IS NULL`,
    )
    .all();

  console.log(`Considering ${rows.length} train alerts with no mentioned_stations`);

  const update = db.prepare('UPDATE alert_posts SET mentioned_stations = ? WHERE alert_id = ?');

  let written = 0;
  let skippedMultiLine = 0;
  let noMentions = 0;
  for (const row of rows) {
    const lines = (row.routes || '').split(',').filter(Boolean);
    if (lines.length !== 1) {
      skippedMultiLine++;
      continue;
    }
    const text = [row.headline, row.short_description].filter(Boolean).join(' \n ');
    const stations = extractMentionedStations(text, lines[0]);
    if (stations.length === 0) {
      noMentions++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`${row.alert_id} (${lines[0]}): ${stations.join(', ')}`);
    } else {
      update.run(JSON.stringify(stations), row.alert_id);
    }
    written++;
  }

  console.log(
    `${DRY_RUN ? 'Would update' : 'Updated'} ${written} rows · ${noMentions} had no resolvable mentions · ${skippedMultiLine} multi-line skipped`,
  );
  db.close();
}

main();
