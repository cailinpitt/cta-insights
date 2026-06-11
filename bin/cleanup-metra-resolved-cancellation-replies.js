#!/usr/bin/env node
// One-off cleanup: remove the misleading "✅ Metra reports this is resolved"
// threaded replies that the pre-lifecycle code posted for single-train
// cancellations before the schedule-anchored lifecycle shipped (2026-06-11).
//
// Those cancellations have since been reclassified (cancel_state='cancelled')
// but their resolved_reply_uri still points at the old "resolved" reply — a
// cancelled train doesn't un-cancel, so that message is wrong. This deletes the
// Bluesky post and nulls resolved_reply_uri on the row.
//
// SAFETY GUARD: only deletes a reply whose post text actually contains "reports
// this is resolved" (the old message from buildMetraResolutionText). A legitimate
// NEW close-note ("scheduled departure time has passed") is never touched, so this
// is safe to run/re-run even after the new lifecycle has posted close-notes.
// Idempotent (a nulled row drops out of the scan) and --dry-run aware.

require('../src/shared/env');

const { getDb } = require('../src/shared/history');
const { loginMetraAlerts } = require('../src/metra/bluesky');
const { runBin } = require('../src/shared/runBin');

const DRY_RUN = process.argv.includes('--dry-run');
const OLD_RESOLVED_MARKER = /reports this is resolved/i;

// at://did:plc:xxx/app.bsky.feed.post/<rkey> → { repo, rkey }
function parseAtUri(uri) {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri || '');
  return m ? { repo: m[1], rkey: m[2] } : null;
}

async function main() {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT alert_id, headline, resolved_reply_uri
      FROM alert_posts
      WHERE kind = 'metra' AND cancel_state = 'cancelled' AND resolved_reply_uri IS NOT NULL
      ORDER BY first_seen_ts DESC
    `)
    .all();

  console.log(
    `cleanup-metra-resolved-cancellation-replies${DRY_RUN ? ' (DRY RUN)' : ''}: ${rows.length} cancellation rows carry a resolved reply`,
  );

  const agent = await loginMetraAlerts();
  const clearReply = db.prepare(
    'UPDATE alert_posts SET resolved_reply_uri = NULL WHERE alert_id = ?',
  );

  let deleted = 0;
  let skippedNotResolved = 0;
  let failed = 0;

  for (const row of rows) {
    const ref = parseAtUri(row.resolved_reply_uri);
    if (!ref) {
      console.warn(`  ! unparseable reply uri for ${row.alert_id}: ${row.resolved_reply_uri}`);
      failed += 1;
      continue;
    }
    // Confirm it's the old "resolved" reply before deleting (safety guard).
    let text = '';
    try {
      const rec = await agent.com.atproto.repo.getRecord({
        repo: ref.repo,
        collection: 'app.bsky.feed.post',
        rkey: ref.rkey,
      });
      text = rec?.data?.value?.text || '';
    } catch (e) {
      console.warn(`  ! could not fetch ${row.resolved_reply_uri} (${e.message}) — skipping`);
      failed += 1;
      continue;
    }
    if (!OLD_RESOLVED_MARKER.test(text)) {
      // Not the old "resolved" reply (e.g. a legitimate close-note) — leave it.
      console.log(`  skip (not a 'resolved' reply): ${row.alert_id} — ${JSON.stringify(text)}`);
      skippedNotResolved += 1;
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would delete: ${row.alert_id} (${row.headline}) — ${row.resolved_reply_uri}`);
      deleted += 1;
      continue;
    }
    try {
      await agent.deletePost(row.resolved_reply_uri);
      clearReply.run(row.alert_id);
      deleted += 1;
      console.log(`  deleted + cleared: ${row.alert_id} (${row.headline})`);
    } catch (e) {
      console.error(`  ! delete failed for ${row.alert_id}: ${e.message}`);
      failed += 1;
    }
  }

  console.log(
    `cleanup-metra-resolved-cancellation-replies: ${DRY_RUN ? 'would delete' : 'deleted'}=${deleted}, skipped(not-resolved)=${skippedNotResolved}, failed=${failed}`,
  );
}

runBin(main);
