#!/usr/bin/env node
// Backfill the structured station fields on existing train alerts by
// re-running the extractor over the stored headline + short_description.
// Supersedes backfill-mentioned-stations.js: it fills all three wire-visible
// columns (affected_from_station, affected_to_station, mentioned_stations),
// and — unlike the older script — it re-extracts rows whose stored value is an
// empty array, not just SQL NULL. That empty-but-present case is exactly what
// the digit-initial-station bug left behind: "between Pulaski and 54th/Cermak"
// failed the [A-Z]-only capture, so ingest wrote affected_from/to = NULL and
// mentioned_stations = '[]', and the station pages dropped the event.
//
// Safety / idempotency:
//   - The extractor fix only made the regexes MORE permissive, so a re-extract
//     is always a superset of what the old ingest stored — it can add stations
//     but never drops one. We still guard each column:
//       * mentioned_stations: written only when the fresh list is strictly
//         larger than what's stored (never shrinks a populated list).
//       * affected_from/to_station: filled only when currently NULL (never
//         overwrites an endpoint a prior run already resolved).
//   - Re-running is a no-op once every row is filled.
//
// Scope mirrors live ingest: single-line train alerts only (the extractor is
// line-scoped; multi-line and bus are out of scope by design).
//
// Defaults to a dry run. Pass --apply to write.

require('../src/shared/env');
const Database = require('better-sqlite3');
const { extractBetweenStations, extractMentionedStations } = require('../src/shared/ctaAlerts');

const DB_PATH =
  process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';
const APPLY = process.argv.includes('--apply');

function parseStored(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function main() {
  const db = new Database(DB_PATH, APPLY ? {} : { readonly: true });

  const cols = db
    .prepare('PRAGMA table_info(alert_posts)')
    .all()
    .map((c) => c.name);
  for (const col of ['affected_from_station', 'affected_to_station', 'mentioned_stations']) {
    if (!cols.includes(col)) {
      if (!APPLY) {
        console.log(`(dry run) column ${col} is missing — --apply would ALTER TABLE to add it`);
      } else {
        db.exec(`ALTER TABLE alert_posts ADD COLUMN ${col} TEXT`);
      }
    }
  }

  const rows = db
    .prepare(
      `SELECT alert_id, routes, headline, short_description,
              affected_from_station, affected_to_station, mentioned_stations
       FROM alert_posts
       WHERE kind = 'train'`,
    )
    .all();

  const update = db.prepare(
    `UPDATE alert_posts
       SET affected_from_station = ?, affected_to_station = ?, mentioned_stations = ?
     WHERE alert_id = ?`,
  );

  let changed = 0;
  let skippedMultiLine = 0;
  const examples = [];

  for (const row of rows) {
    const lines = (row.routes || '').split(',').filter(Boolean);
    if (lines.length !== 1) {
      skippedMultiLine++;
      continue;
    }
    const line = lines[0];
    const text = [row.headline, row.short_description].filter(Boolean).join(' \n ');
    const between = extractBetweenStations(text);
    const freshMentioned = extractMentionedStations(text, line);
    const storedMentioned = parseStored(row.mentioned_stations);

    // Fill endpoints only when absent; only grow the mention list.
    const newFrom = row.affected_from_station ?? (between?.from || null);
    const newTo = row.affected_to_station ?? (between?.to || null);
    const newMentioned =
      freshMentioned.length > storedMentioned.length ? freshMentioned : storedMentioned;

    const fromChanged = newFrom !== (row.affected_from_station ?? null);
    const toChanged = newTo !== (row.affected_to_station ?? null);
    const mentionedChanged = freshMentioned.length > storedMentioned.length;
    if (!fromChanged && !toChanged && !mentionedChanged) continue;

    changed++;
    if (examples.length < 30) {
      examples.push(
        `${row.alert_id} (${line}): from=${newFrom} to=${newTo} mentioned=[${newMentioned.join(', ')}]\n    ${(row.headline || '').slice(0, 90)}`,
      );
    }
    if (APPLY) update.run(newFrom, newTo, JSON.stringify(newMentioned), row.alert_id);
  }

  console.log(`Examined ${rows.length} train alerts (${skippedMultiLine} multi-line skipped)`);
  console.log(examples.join('\n'));
  console.log(
    `\n${APPLY ? 'Updated' : 'Would update'} ${changed} rows. ${APPLY ? '' : 'Re-run with --apply to write.'}`,
  );
  db.close();
}

main();
