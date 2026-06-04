#!/usr/bin/env node
// One-off: scrub the 31 confirmed Purple "local vs express" pulse-cold false
// positives from 2026-05-28 → 2026-06-04 (the FPs the schedule-driven Express
// overlay clip now prevents — commit 9afd314 / docs/ALERTS.md). Deletes the
// Bluesky posts (alert root + ✅ resolution reply + any quote-reposts) on the
// alerts account, then the source disruption_events / thread_quote_posts rows
// so export-web (alerts.json) + export-daily (daily-counts.json) recompute
// clean on the next push-web-data run.
//
// The 2 multi-signal full-line roundup posts in the same window (05-28 16:19,
// 05-29 07:22) are NOT confirmed FPs and are intentionally left untouched —
// they live on a different detector path and aren't in disruption_events.
//
// Dry-run by default; pass --execute to actually delete. Refuses to run if the
// observed-row count in the window isn't the expected 31 (guards against the
// window catching anything new).
//
// Usage (on the server, which has the DB + creds):
//   node scripts/delete-purple-express-fp-2026-06.js            # dry-run
//   node scripts/delete-purple-express-fp-2026-06.js --execute  # for real

require('../src/shared/env');
const Database = require('better-sqlite3');
const { loginAlerts } = require('../src/shared/bluesky');

const DB = process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';
const ALERT_DID = 'did:plc:jgg4dtdflzzemyvnybucnzdw';
// FP window: first FP 2026-05-28 14:38 CDT → last FP 2026-06-04 07:10 CDT.
const WINDOW_START = 1779976800000; // 2026-05-28 00:00 CDT
const WINDOW_END = 1780576000000; // 2026-06-04 ~07:26 CDT (just past the last FP)
const EXPECTED_OBSERVED = 31;

const EXECUTE = process.argv.includes('--execute');

function rkeyOf(uri) {
  return uri ? uri.split('/').pop() : null;
}

async function main() {
  const db = new Database(DB, { readonly: !EXECUTE });

  const fpRows = db
    .prepare(
      `SELECT id, ts, source, from_station, to_station, post_uri
         FROM disruption_events
        WHERE line='p' AND source IN ('observed','observed-clear')
          AND ts BETWEEN ? AND ?
        ORDER BY ts`,
    )
    .all(WINDOW_START, WINDOW_END);

  const observedCount = fpRows.filter((r) => r.source === 'observed').length;
  console.log(
    `FP window rows: ${fpRows.length} (${observedCount} observed + ${fpRows.length - observedCount} observed-clear)`,
  );
  if (observedCount !== EXPECTED_OBSERVED) {
    throw new Error(
      `Expected ${EXPECTED_OBSERVED} observed rows, found ${observedCount}. Aborting — window may have caught something new; re-verify before deleting.`,
    );
  }

  const observedUris = fpRows.filter((r) => r.source === 'observed').map((r) => r.post_uri);
  // Quote-reposts threaded onto any FP root.
  const placeholders = observedUris.map(() => '?').join(',');
  const quoteRows = observedUris.length
    ? db
        .prepare(
          `SELECT thread_root_uri, quote_post_uri FROM thread_quote_posts
            WHERE thread_root_uri IN (${placeholders}) AND quote_post_uri IS NOT NULL`,
        )
        .all(...observedUris)
    : [];

  // Bluesky posts to delete: every FP post_uri + every quote post on the alerts
  // account. Quotes on other accounts (shouldn't happen) are surfaced, not deleted.
  const postUris = fpRows.map((r) => r.post_uri).filter(Boolean);
  const deletableQuotes = [];
  for (const q of quoteRows) {
    if (q.quote_post_uri.includes(ALERT_DID)) deletableQuotes.push(q.quote_post_uri);
    else console.warn(`quote on non-alerts account, delete manually: ${q.quote_post_uri}`);
  }
  const allUris = [...postUris, ...deletableQuotes];

  console.log(
    `\nWill delete ${allUris.length} Bluesky posts (${fpRows.length} pulse posts + ${deletableQuotes.length} quote-reposts) and ${fpRows.length} disruption_events + ${quoteRows.length} thread_quote_posts rows.`,
  );
  for (const r of fpRows) {
    console.log(
      `  ${new Date(r.ts).toISOString()}  ${r.source.padEnd(14)}  ${r.from_station} -> ${r.to_station}  ${rkeyOf(r.post_uri)}`,
    );
  }
  for (const u of deletableQuotes) console.log(`  quote-repost  ${rkeyOf(u)}`);

  if (!EXECUTE) {
    console.log('\nDRY RUN — re-run with --execute to delete.');
    db.close();
    return;
  }

  const agent = await loginAlerts();
  const repoDid = agent.session?.did || agent.did;
  if (repoDid !== ALERT_DID) throw new Error(`Logged in as ${repoDid}, expected ${ALERT_DID}`);

  let ok = 0;
  let fail = 0;
  for (const uri of allUris) {
    const rkey = rkeyOf(uri);
    try {
      await agent.com.atproto.repo.deleteRecord({
        repo: repoDid,
        collection: 'app.bsky.feed.post',
        rkey,
      });
      ok++;
    } catch (e) {
      // "Could not locate record" = already gone; treat as success.
      if (/not.*locate|not found|RecordNotFound/i.test(e.message)) {
        ok++;
      } else {
        fail++;
        console.warn(`delete ${rkey} failed: ${e.message}`);
      }
    }
  }
  console.log(`\nBluesky: ${ok} deleted/absent, ${fail} failed`);

  const tx = db.transaction(() => {
    const ids = fpRows.map((r) => r.id);
    const evDel = db
      .prepare(`DELETE FROM disruption_events WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
    const tqDel = observedUris.length
      ? db
          .prepare(`DELETE FROM thread_quote_posts WHERE thread_root_uri IN (${placeholders})`)
          .run(...observedUris)
      : { changes: 0 };
    console.log(`disruption_events deleted: ${evDel.changes}`);
    console.log(`thread_quote_posts deleted: ${tqDel.changes}`);
  });
  tx();
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
