#!/usr/bin/env node
require('../../src/shared/env');

const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { fetchAlerts, extractBetweenStations, isSignificantAlert } = require('../../src/shared/ctaAlerts');
const { findStationByDestination } = require('../../src/train/findStation');
const { renderDisruption } = require('../../src/map');
const { LINE_COLORS, LINE_NAMES } = require('../../src/train/api');
const { loginAlerts, postWithImage, postText } = require('../../src/shared/bluesky');
const {
  buildAlertPostText, buildAlertAltText, buildResolutionReplyText,
} = require('../../src/shared/alertPost');
const {
  getAlertPost, recordAlertSeen, recordAlertResolved, listUnresolvedAlerts,
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
  const alt = buildAlertAltText({ alert, kind: KIND, disruption });

  let image = null;
  if (disruption) {
    try {
      image = await renderDisruption({
        disruption,
        trainLines,
        lineColors: LINE_COLORS,
        trains: [],
        stations: trainStations,
      });
    } catch (e) {
      console.warn(`renderDisruption failed for alert ${alert.id}: ${e.message}`);
      image = null;
    }
  }

  if (DRY_RUN) {
    const stub = image
      ? writeDryRunAsset(image, `alert-train-${alert.id}-${Date.now()}.jpg`)
      : '(text-only post)';
    console.log(`--- DRY RUN alert ${alert.id} ---\n${text}\n\nAlt: ${alt}\nImage: ${stub}`);
    recordAlertSeen({ alertId: alert.id, kind: KIND, routes: alert.trainLines.join(','), headline: alert.headline, postUri: null });
    return;
  }

  const agent = await agentGetter();
  const result = image
    ? await postWithImage(agent, text, image, alt)
    : await postText(agent, text);
  console.log(`Posted alert ${alert.id}: ${result.url}`);
  recordAlertSeen({ alertId: alert.id, kind: KIND, routes: alert.trainLines.join(','), headline: alert.headline, postUri: result.uri });
}

async function postResolution(alertRow, agentGetter) {
  const pseudoAlert = { headline: alertRow.headline };
  const text = buildResolutionReplyText({ alert: pseudoAlert, kind: KIND });

  if (DRY_RUN) {
    console.log(`--- DRY RUN resolution for alert ${alertRow.alert_id} ---\n${text}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }

  // Original post is missing (dry-run or pre-feature) — mark resolved silently.
  if (!alertRow.post_uri) {
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }

  const agent = await agentGetter();
  try {
    // AtProto reply refs need a CID; look it up since we only stored the URI.
    const [repo, collection, rkey] = parseAtUri(alertRow.post_uri);
    const { data: record } = await agent.com.atproto.repo.getRecord({ repo, collection, rkey });
    const ref = { uri: alertRow.post_uri, cid: record.cid };
    const result = await postText(agent, text, { root: ref, parent: ref });
    console.log(`Posted resolution for alert ${alertRow.alert_id}: ${result.url}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: result.uri });
  } catch (e) {
    console.warn(`Resolution reply failed for alert ${alertRow.alert_id}: ${e.message}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
  }
}

function parseAtUri(uri) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`Invalid at:// URI: ${uri}`);
  return [m[1], m[2], m[3]];
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
    if (existing) {
      recordAlertSeen({ alertId: alert.id, kind: KIND, routes: alert.trainLines.join(','), headline: alert.headline, postUri: null });
      continue;
    }
    try {
      await postNewAlert(alert, agentGetter);
    } catch (e) {
      console.error(`Failed to post alert ${alert.id}: ${e.stack || e.message}`);
    }
  }

  const unresolved = listUnresolvedAlerts(KIND);
  for (const row of unresolved) {
    if (activeIds.has(row.alert_id)) continue;
    try {
      await postResolution(row, agentGetter);
    } catch (e) {
      console.error(`Failed to post resolution for alert ${row.alert_id}: ${e.stack || e.message}`);
    }
  }
}

runBin(main);
