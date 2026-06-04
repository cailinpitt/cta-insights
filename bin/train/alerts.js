#!/usr/bin/env node
require('../../src/shared/env');

const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const {
  fetchAlerts,
  extractBetweenStations,
  extractMentionedStations,
  extractDirection,
  isSignificantAlert,
} = require('../../src/shared/ctaAlerts');
const { sweepRelatedQuotes } = require('../../src/shared/relatedQuotes');
const { findStationByDestination } = require('../../src/train/findStation');
const { renderDisruption } = require('../../src/map');
const { LINE_COLORS, LINE_NAMES } = require('../../src/train/api');
const {
  loginAlerts,
  postWithImage,
  postText,
  postTextWithLinkCard,
  resolveReplyRef,
} = require('../../src/shared/bluesky');
const { resolvedEventLink } = require('../../src/shared/eventLink');
const {
  buildAlertPostText,
  buildAlertAltText,
  buildResolutionReplyText,
  buildResolutionReplyCardTitle,
} = require('../../src/shared/alertPost');
const {
  getAlertPost,
  recordAlertSeen,
  recordAlertResolved,
  incrementAlertClearTicks,
  resetAlertClearTicks,
  listUnresolvedAlerts,
  ALERT_CLEAR_TICKS,
  getRecentPulsePostsAll,
} = require('../../src/shared/history');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

const DRY_RUN = process.env.ALERTS_DRY_RUN === '1' || process.argv.includes('--dry-run');
const KIND = 'train';

function tryBuildDisruption(alert) {
  // Multi-line alerts can't render to a single Disruption — skip the rich path.
  if (alert.trainLines.length !== 1) return null;
  const line = alert.trainLines[0];
  // Extract the disruption segment from the clean summary (headline +
  // shortDescription), NOT fullDescription. The full HTML body carries shuttle
  // walking directions ("From North/Clybourn ... to Armitage", "Clark/Lake")
  // that pollute extractBetweenStations and win over the real segment — e.g.
  // 114934 resolved to "Fullerton → Clark/Lake" (Clark/Lake isn't even on the
  // Red Line) off the full text, so the map silently fell back to text-only.
  // This mirrors the summary-scoped extraction recordAlertSeen already uses.
  const text = [alert.headline, alert.shortDescription].filter(Boolean).join(' \n ');
  const between = extractBetweenStations(text);
  if (!between) return null;
  const from = findStationByDestination(line, between.from);
  const to = findStationByDestination(line, between.to);
  if (!from || !to) return null;
  return {
    line,
    suspendedSegment: { from: from.name, to: to.name },
    alternative: null,
    reason: null,
    source: 'cta-alert',
    detectedAt: Date.now(),
  };
}

async function postNewAlert(alert, agentGetter) {
  const disruption = tryBuildDisruption(alert);
  const text = buildAlertPostText({ alert, kind: KIND, disruption });

  let image = null;
  let alt = null;
  if (disruption) {
    try {
      // CTA alerts cover everything from "single-tracking, minor delays" to
      // full suspensions. We don't classify severity here, so use a neutral
      // map title — the post text carries the actual headline.
      const lineName = LINE_NAMES[disruption.line] || disruption.line;
      image = await renderDisruption({
        disruption,
        trainLines,
        lineColors: LINE_COLORS,
        trains: [],
        stations: trainStations,
        title: `⚠ ${lineName} Line · service impact`,
      });
      alt = buildAlertAltText({ alert, kind: KIND, disruption });
    } catch (e) {
      console.warn(`renderDisruption failed for alert ${alert.id}: ${e.message}`);
      image = null;
      alt = null;
    }
  }

  const routes = alert.trainLines.join(',');

  if (DRY_RUN) {
    const stub = image
      ? writeDryRunAsset(image, `alert-train-${alert.id}-${Date.now()}.jpg`)
      : '(text-only post)';
    console.log(
      `--- DRY RUN alert ${alert.id} (DB write skipped) ---\n${text}\n\nAlt: ${alt || '(no image)'}\nImage: ${stub}`,
    );
    return;
  }

  const between =
    alert.trainLines.length === 1
      ? extractBetweenStations(
          [alert.headline, alert.shortDescription].filter(Boolean).join(' \n '),
        )
      : null;
  const direction =
    alert.trainLines.length === 1
      ? extractDirection(
          [alert.headline, alert.shortDescription].filter(Boolean).join(' \n '),
          alert.trainLines[0],
        )
      : null;
  // Single-line scope mirrors extractBetweenStations — line context is what
  // disambiguates same-named stations across lines (Western Blue vs Brown).
  const mentionedStations =
    alert.trainLines.length === 1
      ? extractMentionedStations(
          [alert.headline, alert.shortDescription].filter(Boolean).join(' \n '),
          alert.trainLines[0],
        )
      : [];
  recordAlertSeen({
    alertId: alert.id,
    kind: KIND,
    routes,
    headline: alert.headline,
    shortDescription: alert.shortDescription || alert.fullDescription || null,
    postUri: null,
    affectedFromStation: between?.from || null,
    affectedToStation: between?.to || null,
    affectedDirection: direction,
    mentionedStations,
    ctaEventStartTs: alert.eventStart ?? null,
    ctaEventStartIsDateOnly: alert.eventStartIsDateOnly ?? false,
    ctaEventEndTs: alert.eventEnd ?? null,
    ctaEventEndIsDateOnly: alert.eventEndIsDateOnly ?? false,
  });

  const agent = await agentGetter();

  // If a recent pulse post on the same line already flagged this disruption,
  // thread the CTA alert under it. For multi-branch lines (Blue O'Hare/
  // Forest Park, Green Ashland/Cottage Grove, etc.) score candidate pulses by
  // station-name overlap with the alert text so we don't thread under an
  // unrelated-branch pulse.
  let replyRef = null;
  if (alert.trainLines.length === 1) {
    const pulses = getRecentPulsePostsAll({
      kind: KIND,
      line: alert.trainLines[0],
      withinMs: 24 * 60 * 60 * 1000,
    });
    if (pulses.length > 0) {
      const text = (
        alert.fullDescription ||
        alert.shortDescription ||
        alert.headline ||
        ''
      ).toLowerCase();
      const scored = pulses
        .map((p) => {
          const fromHit = p.from_station && text.includes(p.from_station.toLowerCase()) ? 1 : 0;
          const toHit = p.to_station && text.includes(p.to_station.toLowerCase()) ? 1 : 0;
          return { ...p, score: fromHit + toHit };
        })
        .sort((a, b) => b.score - a.score || b.ts - a.ts);
      // Require at least one station-name hit before threading. Without this,
      // a CTA alert with no station mentions (e.g. "Brown Line Service
      // Experiencing Significant Delays Due to Raised Bridge") falls back to
      // most-recent-pulse-wins and ends up threaded under an unrelated pulse
      // elsewhere on the same line. Score 0 = no textual link, no thread.
      const winner = scored[0];
      if (winner && winner.score > 0) {
        replyRef = await resolveReplyRef(agent, winner.post_uri);
      }
    }
  }

  const result = image
    ? await postWithImage(agent, text, image, alt, replyRef)
    : await postText(agent, text, replyRef);
  console.log(
    `Posted alert ${alert.id}${replyRef ? ' (threaded under pulse)' : ''}: ${result.url}`,
  );
  recordAlertSeen({
    alertId: alert.id,
    kind: KIND,
    routes,
    headline: alert.headline,
    shortDescription: alert.shortDescription || alert.fullDescription || null,
    postUri: result.uri,
    ctaEventStartTs: alert.eventStart ?? null,
    ctaEventStartIsDateOnly: alert.eventStartIsDateOnly ?? false,
    ctaEventEndTs: alert.eventEnd ?? null,
    ctaEventEndIsDateOnly: alert.eventEndIsDateOnly ?? false,
  });
}

async function postResolution(alertRow, agentGetter) {
  // Already carries a resolution reply from an earlier chapter: the alert
  // flickered out, we posted "CTA cleared", then CTA re-listed it within the
  // flicker window and recordAlertSeen reopened it (keeping resolved_reply_uri).
  // Re-stamp resolved_ts to this clear without posting a duplicate reply.
  if (alertRow.resolved_reply_uri) {
    if (DRY_RUN) {
      console.log(
        `--- DRY RUN alert ${alertRow.alert_id} re-resolved after flicker; would keep existing reply, no duplicate (DB write skipped) ---`,
      );
      return;
    }
    console.log(
      `Alert ${alertRow.alert_id} re-resolved after flicker — keeping existing reply, no duplicate posted`,
    );
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: alertRow.resolved_reply_uri });
    return;
  }
  const pseudoAlert = { headline: alertRow.headline };
  const text = buildResolutionReplyText({ alert: pseudoAlert, kind: KIND });

  if (DRY_RUN) {
    console.log(
      `--- DRY RUN resolution for alert ${alertRow.alert_id} (DB write skipped) ---\n${text}`,
    );
    return;
  }

  if (!alertRow.post_uri) {
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }

  const agent = await agentGetter();
  try {
    // resolveReplyRef inherits the alert's own root when it was itself a
    // reply (e.g. threaded under an earlier pulse), so the resolution lands
    // in the same thread instead of starting a sub-thread.
    const replyRef = await resolveReplyRef(agent, alertRow.post_uri);
    if (!replyRef) throw new Error('could not resolve reply ref for alert post');
    const link = resolvedEventLink(
      alertRow.post_uri,
      buildResolutionReplyCardTitle({ alert: pseudoAlert }),
    );
    const result = link
      ? await postTextWithLinkCard(agent, text, replyRef, link)
      : await postText(agent, text, replyRef);
    console.log(`Posted resolution for alert ${alertRow.alert_id}: ${result.url}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: result.uri });
  } catch (e) {
    console.warn(`Resolution reply failed for alert ${alertRow.alert_id}: ${e.message}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
  }
}

async function main() {
  setup();
  const alerts = await fetchAlerts({ activeOnly: true });
  const relevant = alerts.filter((a) => a.trainLines.length > 0 && isSignificantAlert(a));
  const activeIds = new Set(relevant.map((a) => a.id));
  // Pre-filter set: alerts CTA still considers active, regardless of our
  // significance gate. Used by the resolution sweep to distinguish "CTA
  // cleared this" (post a resolution reply) from "we filtered it out"
  // (silent close — posting a 'CTA has cleared' reply would be a lie).
  const ctaActiveIds = new Set(alerts.map((a) => a.id));

  console.log(`Fetched ${alerts.length} active alerts, ${relevant.length} relevant to rail`);

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  for (const alert of relevant) {
    const existing = getAlertPost(alert.id);
    if (existing?.post_uri) {
      if (!DRY_RUN) {
        recordAlertSeen({
          alertId: alert.id,
          kind: KIND,
          routes: alert.trainLines.join(','),
          headline: alert.headline,
          shortDescription: alert.shortDescription || alert.fullDescription || null,
          postUri: null,
          ctaEventStartTs: alert.eventStart ?? null,
          ctaEventStartIsDateOnly: alert.eventStartIsDateOnly ?? false,
          ctaEventEndTs: alert.eventEnd ?? null,
          ctaEventEndIsDateOnly: alert.eventEndIsDateOnly ?? false,
        });
      }
      continue;
    }
    try {
      await postNewAlert(alert, agentGetter);
    } catch (e) {
      console.error(`Failed to post alert ${alert.id}: ${e.stack || e.message}`);
    }
  }

  // Quote-attach pass — runs regardless of CTA-fetch outcome, since active
  // anchors (existing alerts, observation pulses) are independent of this
  // tick's fetch.
  try {
    await sweepRelatedQuotes({ kind: KIND, agentGetter, dryRun: DRY_RUN });
  } catch (e) {
    console.error(`related-quotes sweep failed: ${e.stack || e.message}`);
  }

  if (alerts.length === 0) {
    console.warn('CTA returned 0 active alerts — skipping resolution sweep this tick');
    return;
  }

  const unresolved = listUnresolvedAlerts(KIND);
  const sweepNow = Date.now();
  for (const row of unresolved) {
    if (activeIds.has(row.alert_id)) {
      if (!DRY_RUN && row.clear_ticks > 0) resetAlertClearTicks(row.alert_id);
      continue;
    }
    // Still in CTA's feed but our gate now rejects it (e.g. tightened the
    // significance filter). Mark resolved silently — the original post
    // stays, but we stop tracking and don't post a misleading "CTA has
    // cleared" reply.
    if (ctaActiveIds.has(row.alert_id)) {
      if (DRY_RUN) {
        console.log(
          `--- DRY RUN would silently close alert ${row.alert_id} (still in CTA feed but filtered out; DB write skipped) ---`,
        );
        continue;
      }
      console.log(
        `Alert ${row.alert_id} silently closed — still in CTA feed but no longer passes significance gate`,
      );
      recordAlertResolved({ alertId: row.alert_id, replyUri: null });
      continue;
    }
    if (DRY_RUN) {
      console.log(
        `--- DRY RUN would advance clear_ticks for alert ${row.alert_id} (DB write skipped) ---`,
      );
      continue;
    }
    // Pass sweepNow so the helper backdates pending_resolved_ts to this
    // tick (the first time CTA's feed didn't include the alert), not the
    // future threshold-tick when resolution actually posts.
    const next = incrementAlertClearTicks(row.alert_id, sweepNow);
    if (next < ALERT_CLEAR_TICKS) {
      console.log(`Alert ${row.alert_id} missing tick ${next}/${ALERT_CLEAR_TICKS}`);
      continue;
    }
    try {
      await postResolution(row, agentGetter);
    } catch (e) {
      console.error(`Failed to post resolution for alert ${row.alert_id}: ${e.stack || e.message}`);
    }
  }
}

runBin(main);
