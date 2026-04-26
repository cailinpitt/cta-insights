#!/usr/bin/env node
require('../../src/shared/env');

const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const {
  fetchAlerts,
  extractBetweenStations,
  isSignificantAlert,
} = require('../../src/shared/ctaAlerts');
const { findStationByDestination } = require('../../src/train/findStation');
const { renderDisruption } = require('../../src/map');
const { LINE_COLORS } = require('../../src/train/api');
const {
  loginAlerts,
  postWithImage,
  postText,
  resolveReplyRef,
} = require('../../src/shared/bluesky');
const {
  buildAlertPostText,
  buildAlertAltText,
  buildResolutionReplyText,
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
  const text = alert.fullDescription || alert.shortDescription || alert.headline;
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
      image = await renderDisruption({
        disruption,
        trainLines,
        lineColors: LINE_COLORS,
        trains: [],
        stations: trainStations,
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

  recordAlertSeen({
    alertId: alert.id,
    kind: KIND,
    routes,
    headline: alert.headline,
    postUri: null,
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
      const winner = scored[0];
      if (winner) replyRef = await resolveReplyRef(agent, winner.post_uri);
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
    postUri: result.uri,
  });
}

async function postResolution(alertRow, agentGetter) {
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
    const result = await postText(agent, text, replyRef);
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
          postUri: null,
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

  if (alerts.length === 0) {
    console.warn('CTA returned 0 active alerts — skipping resolution sweep this tick');
    return;
  }

  const unresolved = listUnresolvedAlerts(KIND);
  for (const row of unresolved) {
    if (activeIds.has(row.alert_id)) {
      if (!DRY_RUN && row.clear_ticks > 0) resetAlertClearTicks(row.alert_id);
      continue;
    }
    if (DRY_RUN) {
      console.log(
        `--- DRY RUN would advance clear_ticks for alert ${row.alert_id} (DB write skipped) ---`,
      );
      continue;
    }
    const next = incrementAlertClearTicks(row.alert_id);
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
