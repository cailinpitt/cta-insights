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

const Path = require('node:path');
const Fs = require('node:fs');
const { setup, runBin } = require('../../src/shared/runBin');
const { getMetraAlerts } = require('../../src/metra/api');
const {
  isSignificantMetraAlert,
  alertRelevance,
  buildMetraAlertText,
  buildMetraResolutionText,
  buildMetraResolutionCardTitle,
  buildMetraCancellationCloseText,
  buildMetraDelayCloseText,
} = require('../../src/metra/metraAlerts');
const { classifyCancellationAlert } = require('../../src/metra/cancellationAlert');
const { classifyDelayAlert } = require('../../src/metra/delayAlert');
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
  recordCancellation,
  finalizeCancellation,
  recordDelay,
  finalizeDelay,
  incrementAlertClearTicks,
  resetAlertClearTicks,
  listUnresolvedAlerts,
  ALERT_CLEAR_TICKS,
} = require('../../src/shared/history');

const DRY_RUN = process.env.METRA_DRY_RUN === '1' || process.argv.includes('--dry-run');
const KIND = 'metra';

// GTFS schedule index — lets us resolve a single-train cancellation alert to the
// concrete trip it annuls (its scheduled departure/arrival). Missing index → we
// simply can't anchor cancellations to the schedule this run, so every alert
// falls back to the open-ended ongoing→resolved path (classify returns null).
function loadIndex() {
  try {
    const p = Path.join(__dirname, '..', '..', 'data', 'metra-gtfs', 'index.json');
    return JSON.parse(Fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null;
  }
}

// External boundaries (the feed, the GTFS index, and the Bluesky login/post calls)
// grouped behind one object so the lifecycle orchestration can be exercised with
// injected fakes — the bin needs no network, login, or real posting to be tested.
const io = {
  getMetraAlerts,
  loadIndex,
  loginMetraAlerts,
  postText,
  postTextWithLinkCard,
  resolveReplyRef,
};

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

// Persist the schedule-anchored cancellation facts on an alert row, and — when the
// train's scheduled departure is already in the past at first sight (a same-day
// annulment announced after the train was due out, like UPW #67) — finalize it
// immediately and silently: the original post already states the train won't run,
// so no threaded "departure has passed" note is warranted. Advance cancellations
// stay 'upcoming' here; the sweep posts the close-note when their time arrives.
function persistCancellation(alertId, cancel, now = Date.now()) {
  recordCancellation({
    alertId,
    depTs: cancel.scheduledDepMs,
    arrTs: cancel.scheduledArrMs,
    trainNo: cancel.trainNumber,
    origin: cancel.origin,
  });
  if (now >= cancel.scheduledDepMs) {
    finalizeCancellation({ alertId, replyUri: null });
  }
}

// Persist the schedule-anchored deadline of a single-train delay. Unlike a
// cancellation we never finalize on first sight here: even a delay first seen after
// its deadline gets the close-note via the sweep (it carries the schedule context
// riders want, unlike an already-departed annulment whose post already says it
// won't run). recordDelay pushes the deadline out if a worse delay arrives.
function persistDelay(alertId, delay) {
  recordDelay({
    alertId,
    deadlineTs: delay.deadlineMs,
    delayMin: delay.maxDelayMin,
    trainNo: delay.trainNumber,
  });
}

async function postNewAlert(alert, cancel, delay, agentGetter, now = Date.now()) {
  const routes = routesFor(alert);
  const text = buildMetraAlertText(alert);

  if (DRY_RUN) {
    const tag = cancel
      ? ` [single-train cancellation ${cancel.route} #${cancel.trainNumber}, dep ${new Date(cancel.scheduledDepMs).toISOString()}]`
      : delay
        ? ` [single-train delay ${delay.route} #${delay.trainNumber}, +${delay.maxDelayMin}m, resolve-at ${new Date(delay.deadlineMs).toISOString()}]`
        : '';
    console.log(`--- DRY RUN metra alert ${alert.id} (DB write skipped)${tag} ---\n${text}\n`);
    return;
  }

  const mentionedStations = mentionedFor(alert);

  // Pre-post write (postUri:null) so a crash between posting and the post-post
  // write is still detectable — mirrors the CTA invariant.
  recordAlertSeen(
    {
      alertId: alert.id,
      kind: KIND,
      routes,
      headline: alert.header,
      shortDescription: alert.description || null,
      postUri: null,
      mentionedStations,
    },
    now,
  );

  const agent = await agentGetter();
  const result = await io.postText(agent, text);
  console.log(`Posted metra alert ${alert.id}: ${result.url}`);
  recordAlertSeen(
    {
      alertId: alert.id,
      kind: KIND,
      routes,
      headline: alert.header,
      shortDescription: alert.description || null,
      postUri: result.uri,
      mentionedStations,
    },
    now,
  );
  // After the row exists with its post_uri, anchor the cancellation/delay to the
  // schedule (mutually exclusive — the classifiers don't both fire on one alert).
  if (cancel) persistCancellation(alert.id, cancel, now);
  else if (delay) persistDelay(alert.id, delay);
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
    const replyRef = await io.resolveReplyRef(agent, alertRow.post_uri);
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
      ? await io.postTextWithLinkCard(agent, text, replyRef, link)
      : await io.postText(agent, text, replyRef);
    console.log(`Posted metra resolution for alert ${alertRow.alert_id}: ${result.url}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: result.uri });
  } catch (e) {
    console.warn(`Metra resolution reply failed for alert ${alertRow.alert_id}: ${e.message}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
  }
}

// Close a single-train cancellation whose scheduled departure has passed: post the
// neutral threaded note (NOT a "resolved" reply) and finalize. Finalize happens
// even if the reply fails — the schedule, not the post, is the source of truth.
async function postCancellationClose(alertRow, agentGetter) {
  if (DRY_RUN) {
    console.log(
      `--- DRY RUN metra cancellation close for alert ${alertRow.alert_id} (DB write skipped) ---`,
    );
    return;
  }
  if (!alertRow.post_uri) {
    finalizeCancellation({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }
  const text = buildMetraCancellationCloseText();
  const agent = await agentGetter();
  try {
    const replyRef = await io.resolveReplyRef(agent, alertRow.post_uri);
    if (!replyRef) throw new Error('could not resolve reply ref for alert post');
    const result = await io.postText(agent, text, replyRef);
    console.log(`Posted metra cancellation close for alert ${alertRow.alert_id}: ${result.url}`);
    finalizeCancellation({ alertId: alertRow.alert_id, replyUri: result.uri });
  } catch (e) {
    console.warn(`Metra cancellation close failed for alert ${alertRow.alert_id}: ${e.message}`);
    finalizeCancellation({ alertId: alertRow.alert_id, replyUri: null });
  }
}

// Schedule-anchored finalize sweep for single-train cancellations: any still
// 'upcoming' whose scheduled departure has now passed gets its close-note + is
// finalized. Runs INDEPENDENT of the live feed (even on an empty feed), because
// the timetable — not Metra leaving the alert on the wire — decides when the
// train's slot is over.
async function sweepCancellationCloses(agentGetter, now = Date.now()) {
  const due = listUnresolvedAlerts(KIND).filter(
    (r) => r.cancel_dep_ts != null && r.cancel_state === 'upcoming' && now >= r.cancel_dep_ts,
  );
  for (const row of due) {
    try {
      await postCancellationClose(row, agentGetter);
    } catch (e) {
      console.error(`Failed metra cancellation close for ${row.alert_id}: ${e.stack || e.message}`);
    }
  }
}

// Close a single-train delay whose schedule-anchored deadline has passed: post the
// neutral threaded note (NOT a "✅ resolved" reply — Metra hasn't cleared it; we
// inferred from the timetable that the train has arrived) and finalize. Finalize
// happens even if the reply fails — the schedule, not the post, is the source of
// truth.
async function postDelayClose(alertRow, agentGetter) {
  if (DRY_RUN) {
    console.log(
      `--- DRY RUN metra delay close for alert ${alertRow.alert_id} (DB write skipped) ---`,
    );
    return;
  }
  if (!alertRow.post_uri) {
    finalizeDelay({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }
  const text = buildMetraDelayCloseText();
  const agent = await agentGetter();
  try {
    const replyRef = await io.resolveReplyRef(agent, alertRow.post_uri);
    if (!replyRef) throw new Error('could not resolve reply ref for alert post');
    const result = await io.postText(agent, text, replyRef);
    console.log(`Posted metra delay close for alert ${alertRow.alert_id}: ${result.url}`);
    finalizeDelay({ alertId: alertRow.alert_id, replyUri: result.uri });
  } catch (e) {
    console.warn(`Metra delay close failed for alert ${alertRow.alert_id}: ${e.message}`);
    finalizeDelay({ alertId: alertRow.alert_id, replyUri: null });
  }
}

// Schedule-anchored finalize sweep for single-train delays: any unresolved row whose
// deadline (final scheduled arrival + announced delay + grace) has now passed gets
// its close-note + is finalized. Runs INDEPENDENT of the live feed (even on an empty
// feed, and even while Metra still shows the delay), because the timetable — not
// Metra leaving the alert on the wire — decides when the train's run is over.
async function sweepDelayResolutions(agentGetter, now = Date.now()) {
  const due = listUnresolvedAlerts(KIND).filter(
    (r) => r.delay_deadline_ts != null && now >= r.delay_deadline_ts,
  );
  for (const row of due) {
    try {
      await postDelayClose(row, agentGetter);
    } catch (e) {
      console.error(`Failed metra delay close for ${row.alert_id}: ${e.stack || e.message}`);
    }
  }
}

async function main({ now = Date.now() } = {}) {
  setup();
  const alerts = await io.getMetraAlerts();
  const index = io.loadIndex();
  if (!index) {
    console.warn('metra alerts: schedule index missing — cancellations fall back to feed-drop');
  }
  const relevant = alerts.filter(isSignificantMetraAlert);
  const significantIds = new Set(relevant.map((a) => a.id));
  // Everything currently in the feed, regardless of our gate — used by the
  // resolution sweep to tell "Metra cleared it" (post a resolution) from "we
  // filtered it out" (silent close).
  const feedIds = new Set(alerts.map((a) => a.id));

  console.log(`Fetched ${alerts.length} Metra alerts, ${relevant.length} significant`);

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await io.loginMetraAlerts();
    return agent;
  };

  // Classify each significant alert once — a resolved single-train cancellation or
  // delay descriptor, or null (open-ended notice → existing ongoing→resolved path).
  // The two are mutually exclusive: classifyDelayAlert bails on cancellation text.
  const cancelFor = (alert) => (index ? classifyCancellationAlert({ alert, index, now }) : null);
  const delayFor = (alert) => (index ? classifyDelayAlert({ alert, index, now }) : null);

  for (const alert of relevant) {
    const cancel = cancelFor(alert);
    const delay = cancel ? null : delayFor(alert);
    const existing = getAlertPost(alert.id);
    if (existing?.post_uri) {
      // Already posted — refresh last_seen so the resolution sweep doesn't think
      // it dropped out. (postUri:null preserves the stored URI via COALESCE.)
      if (!DRY_RUN) {
        recordAlertSeen(
          {
            alertId: alert.id,
            kind: KIND,
            routes: routesFor(alert),
            headline: alert.header,
            shortDescription: alert.description || null,
            postUri: null,
            // Backfill mentioned stations on re-sight so alerts posted before this
            // shipped pick them up without a new post.
            mentionedStations: mentionedFor(alert),
          },
          now,
        );
        // Backfill the cancellation/delay window on re-sight too, so alerts posted
        // before this shipped (or before the index resolved) get anchored, and a
        // worsening delay pushes its deadline out. Never downgrades a finalized row.
        if (cancel) persistCancellation(alert.id, cancel, now);
        else if (delay) persistDelay(alert.id, delay);
      }
      continue;
    }
    try {
      await postNewAlert(alert, cancel, delay, agentGetter, now);
    } catch (e) {
      console.error(`Failed to post metra alert ${alert.id}: ${e.stack || e.message}`);
    }
  }

  // Schedule-anchored cancellation closes — before the empty-feed guard, since
  // these are driven by the timetable, not by what's currently on the wire.
  await sweepCancellationCloses(agentGetter, now);
  // Schedule-anchored delay closes — also timetable-driven, so likewise before the
  // empty-feed guard. Resolves a delay the moment the train should have arrived,
  // even while Metra still shows it on the wire.
  await sweepDelayResolutions(agentGetter, now);

  // Feed flicker guard: Metra occasionally returns an empty feed; don't treat
  // that as "everything resolved at once".
  if (alerts.length === 0) {
    console.warn('Metra returned 0 alerts — skipping resolution sweep this tick');
    return;
  }

  const unresolved = listUnresolvedAlerts(KIND);
  const sweepNow = now;
  for (const row of unresolved) {
    // Single-train cancellations are schedule-driven, not feed-driven: their
    // lifecycle is owned entirely by sweepCancellationCloses above. Never let the
    // feed-drop path post a "✅ resolved" reply for an annulled train.
    if (row.cancel_dep_ts != null) continue;
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

module.exports = { main, io };
