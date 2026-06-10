#!/usr/bin/env node
// Republishes Metra's GTFS-realtime service alerts to the Metra alerts account,
// and posts a threaded "resolved" reply when an alert drops out of the feed.
// Metra analog of bin/train/alerts.js, but streamlined for Phase 1:
//   - input is native GTFS-rt (no XML quirks, no severity scoring);
//   - alert posts are text-only (no disruption-segment maps yet);
//   - the resolved reply carries a link card to the incident's archive page on
//     chicagotransitalerts.app (the /resolved OG variant), like the CTA accounts;
//   - no pulse-threading / related-quotes sweep (those arrive with cancellations
//     in Phase 2).
// Reuses the kind-generic alert_posts lifecycle helpers in src/shared/history.js
// with kind='metra'.

require('../../src/shared/env');

const { setup, runBin } = require('../../src/shared/runBin');
const { getMetraAlerts } = require('../../src/metra/api');
const {
  isSignificantMetraAlert,
  alertRelevance,
  buildMetraAlertText,
  buildMetraResolutionText,
  buildMetraResolutionCardTitle,
} = require('../../src/metra/metraAlerts');
const { extractMetraStations } = require('../../src/metra/metraStations');
const {
  loginMetraAlerts,
  postText,
  postTextWithLinkCard,
  resolveReplyRef,
} = require('../../src/metra/bluesky');
const { resolvedEventLink } = require('../../src/shared/eventLink');
const {
  getAlertPost,
  recordAlertSeen,
  recordAlertResolved,
  incrementAlertClearTicks,
  resetAlertClearTicks,
  listUnresolvedAlerts,
  ALERT_CLEAR_TICKS,
} = require('../../src/shared/history');

const DRY_RUN = process.env.METRA_DRY_RUN === '1' || process.argv.includes('--dry-run');
const KIND = 'metra';

// Comma-joined route_ids the alert touches (empty for agency-wide notices) —
// stored on alert_posts.routes the same way CTA stores its line list.
function routesFor(alert) {
  return alertRelevance(alert).lines.join(',');
}

// Canonical Metra station names referenced in the alert text — resolved upstream
// (with the friendly→GTFS terminal alias map) so the frontend can render them as
// links without re-parsing free text.
function mentionedFor(alert) {
  return extractMetraStations([alert.header, alert.description].filter(Boolean).join(' \n '));
}

async function postNewAlert(alert, agentGetter) {
  const routes = routesFor(alert);
  const text = buildMetraAlertText(alert);

  if (DRY_RUN) {
    console.log(`--- DRY RUN metra alert ${alert.id} (DB write skipped) ---\n${text}\n`);
    return;
  }

  const mentionedStations = mentionedFor(alert);

  // Pre-post write (postUri:null) so a crash between posting and the post-post
  // write is still detectable — mirrors the CTA invariant.
  recordAlertSeen({
    alertId: alert.id,
    kind: KIND,
    routes,
    headline: alert.header,
    shortDescription: alert.description || null,
    postUri: null,
    mentionedStations,
  });

  const agent = await agentGetter();
  const result = await postText(agent, text);
  console.log(`Posted metra alert ${alert.id}: ${result.url}`);
  recordAlertSeen({
    alertId: alert.id,
    kind: KIND,
    routes,
    headline: alert.header,
    shortDescription: alert.description || null,
    postUri: result.uri,
    mentionedStations,
  });
}

async function postResolution(alertRow, agentGetter) {
  const text = buildMetraResolutionText(alertRow.headline);

  if (DRY_RUN) {
    console.log(
      `--- DRY RUN metra resolution for alert ${alertRow.alert_id} (DB write skipped) ---\n${text}`,
    );
    return;
  }

  if (!alertRow.post_uri) {
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }

  const agent = await agentGetter();
  try {
    const replyRef = await resolveReplyRef(agent, alertRow.post_uri);
    if (!replyRef) throw new Error('could not resolve reply ref for alert post');
    // Attach a link card to the incident's archive page on
    // chicagotransitalerts.app (the /resolved variant, with its "Archived" OG
    // card), mirroring the CTA alerts account. The rkey comes from the original
    // alert post, which is also the event page's id.
    const link = resolvedEventLink(
      alertRow.post_uri,
      buildMetraResolutionCardTitle(alertRow.headline),
    );
    const result = link
      ? await postTextWithLinkCard(agent, text, replyRef, link)
      : await postText(agent, text, replyRef);
    console.log(`Posted metra resolution for alert ${alertRow.alert_id}: ${result.url}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: result.uri });
  } catch (e) {
    console.warn(`Metra resolution reply failed for alert ${alertRow.alert_id}: ${e.message}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
  }
}

async function main() {
  setup();
  const alerts = await getMetraAlerts();
  const relevant = alerts.filter(isSignificantMetraAlert);
  const significantIds = new Set(relevant.map((a) => a.id));
  // Everything currently in the feed, regardless of our gate — used by the
  // resolution sweep to tell "Metra cleared it" (post a resolution) from "we
  // filtered it out" (silent close).
  const feedIds = new Set(alerts.map((a) => a.id));

  console.log(`Fetched ${alerts.length} Metra alerts, ${relevant.length} significant`);

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginMetraAlerts();
    return agent;
  };

  for (const alert of relevant) {
    const existing = getAlertPost(alert.id);
    if (existing?.post_uri) {
      // Already posted — refresh last_seen so the resolution sweep doesn't think
      // it dropped out. (postUri:null preserves the stored URI via COALESCE.)
      if (!DRY_RUN) {
        recordAlertSeen({
          alertId: alert.id,
          kind: KIND,
          routes: routesFor(alert),
          headline: alert.header,
          shortDescription: alert.description || null,
          postUri: null,
          // Backfill mentioned stations on re-sight so alerts posted before this
          // shipped pick them up without a new post.
          mentionedStations: mentionedFor(alert),
        });
      }
      continue;
    }
    try {
      await postNewAlert(alert, agentGetter);
    } catch (e) {
      console.error(`Failed to post metra alert ${alert.id}: ${e.stack || e.message}`);
    }
  }

  // Feed flicker guard: Metra occasionally returns an empty feed; don't treat
  // that as "everything resolved at once".
  if (alerts.length === 0) {
    console.warn('Metra returned 0 alerts — skipping resolution sweep this tick');
    return;
  }

  const unresolved = listUnresolvedAlerts(KIND);
  const sweepNow = Date.now();
  for (const row of unresolved) {
    if (significantIds.has(row.alert_id)) {
      if (!DRY_RUN && row.clear_ticks > 0) resetAlertClearTicks(row.alert_id);
      continue;
    }
    // Still in the feed but no longer passes the gate — close silently (no
    // misleading "resolved" reply); the original post stays.
    if (feedIds.has(row.alert_id)) {
      if (DRY_RUN) {
        console.log(
          `--- DRY RUN would silently close metra alert ${row.alert_id} (still in feed, filtered) ---`,
        );
        continue;
      }
      console.log(
        `Metra alert ${row.alert_id} silently closed — still in feed but no longer significant`,
      );
      recordAlertResolved({ alertId: row.alert_id, replyUri: null });
      continue;
    }
    if (DRY_RUN) {
      console.log(`--- DRY RUN would advance clear_ticks for metra alert ${row.alert_id} ---`);
      continue;
    }
    const next = incrementAlertClearTicks(row.alert_id, sweepNow);
    if (next < ALERT_CLEAR_TICKS) {
      console.log(`Metra alert ${row.alert_id} missing tick ${next}/${ALERT_CLEAR_TICKS}`);
      continue;
    }
    try {
      await postResolution(row, agentGetter);
    } catch (e) {
      console.error(`Failed metra resolution for alert ${row.alert_id}: ${e.stack || e.message}`);
    }
  }
}

if (require.main === module) {
  runBin(main);
}

module.exports = { main };
