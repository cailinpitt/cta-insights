#!/usr/bin/env node
// One-off backfill for alert_posts.cta_event_start_ts / cta_event_end_ts and
// their is-date-only flags.
//
// CTA sometimes posts EventStart/EventEnd as bare dates ("2026-05-25") that
// the old parseCtaDate rejected, leaving the columns NULL on alert_posts rows
// captured before the date-only parser landed. recordAlertSeen only fills
// these while CTA still considers the alert active and the bot still treats
// it as significant, so a stale alert that's currently filtered out (e.g.
// significance gate flip) won't otherwise pick up the new values.
//
// Fetches activeonly=false from CTA and updates any matching alert_post row
// whose end_ts is NULL but the feed now provides one. Also refreshes the
// date-only flags when CTA's posted form has changed. Idempotent — safe to
// re-run; only writes when the new value differs from what's already stored.

require('../src/shared/env');

const { fetchAlerts } = require('../src/shared/ctaAlerts');
const { getDb } = require('../src/shared/history');
const { runBin } = require('../src/shared/runBin');

async function main() {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT alert_id,
             cta_event_start_ts,
             cta_event_end_ts,
             cta_event_start_is_date_only,
             cta_event_end_is_date_only
      FROM alert_posts
      ORDER BY first_seen_ts DESC
    `)
    .all();

  console.log(`backfill-cta-event-times: scanning ${rows.length} alert_post rows`);

  const alerts = await fetchAlerts({ activeOnly: false });
  const byId = new Map(alerts.map((a) => [a.id, a]));

  const update = db.prepare(`
    UPDATE alert_posts
    SET cta_event_start_ts = ?,
        cta_event_start_is_date_only = ?,
        cta_event_end_ts = ?,
        cta_event_end_is_date_only = ?
    WHERE alert_id = ?
  `);

  let filled = 0;
  let notInFeed = 0;
  let unchanged = 0;

  for (const row of rows) {
    const cta = byId.get(row.alert_id);
    if (!cta) {
      notInFeed += 1;
      continue;
    }
    const newStart = cta.eventStart ?? null;
    const newEnd = cta.eventEnd ?? null;
    const newStartDate = cta.eventStartIsDateOnly ? 1 : 0;
    const newEndDate = cta.eventEndIsDateOnly ? 1 : 0;
    const changed =
      row.cta_event_start_ts !== newStart ||
      row.cta_event_end_ts !== newEnd ||
      row.cta_event_start_is_date_only !== newStartDate ||
      row.cta_event_end_is_date_only !== newEndDate;
    if (!changed) {
      unchanged += 1;
      continue;
    }
    update.run(newStart, newStartDate, newEnd, newEndDate, row.alert_id);
    filled += 1;
    console.log(
      `  updated ${row.alert_id}: start=${newStart} (date_only=${newStartDate}) end=${newEnd} (date_only=${newEndDate})`,
    );
  }

  console.log(
    `backfill-cta-event-times: updated=${filled}, unchanged=${unchanged}, not-in-feed=${notInFeed}`,
  );
}

runBin(main);
