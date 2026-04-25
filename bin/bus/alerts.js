#!/usr/bin/env node
// Auto-post CTA bus service alerts.
//
// Bus alerts are text-only (no equivalent of the train disruption map since
// bus "service between X and Y" is rare — most bus alerts are reroutes/detours
// that don't map cleanly to a polyline segment). Otherwise identical in
// dedup/resolution behavior to bin/train/alerts.js.

require('../../src/shared/env');

const { setup, runBin } = require('../../src/shared/runBin');
const { fetchAlerts, isSignificantAlert } = require('../../src/shared/ctaAlerts');
const { loginAlerts, postText } = require('../../src/shared/bluesky');
const {
  buildAlertPostText, buildResolutionReplyText,
} = require('../../src/shared/alertPost');
const {
  getAlertPost, recordAlertSeen, recordAlertResolved, listUnresolvedAlerts,
} = require('../../src/shared/history');
const busRoutes = require('../../src/bus/routes');

const DRY_RUN = process.env.ALERTS_DRY_RUN === '1' || process.argv.includes('--dry-run');
const KIND = 'bus';

// Only post bus alerts for routes the bot actively covers — avoids a firehose
// of route-57-branch-reroute alerts that our followers don't care about.
const TRACKED = new Set([
  ...busRoutes.bunching, ...busRoutes.gaps, ...busRoutes.speedmap, ...busRoutes.ghosts,
]);

function isRelevant(alert) {
  if (!isSignificantAlert(alert)) return false;
  return alert.busRoutes.some((r) => TRACKED.has(r));
}

async function postNewAlert(alert, agentGetter) {
  const text = buildAlertPostText({ alert, kind: KIND });
  if (DRY_RUN) {
    console.log(`--- DRY RUN alert ${alert.id} ---\n${text}`);
    recordAlertSeen({ alertId: alert.id, kind: KIND, routes: alert.busRoutes.join(','), headline: alert.headline, postUri: null });
    return;
  }
  const agent = await agentGetter();
  const result = await postText(agent, text);
  console.log(`Posted alert ${alert.id}: ${result.url}`);
  recordAlertSeen({ alertId: alert.id, kind: KIND, routes: alert.busRoutes.join(','), headline: alert.headline, postUri: result.uri });
}

function parseAtUri(uri) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`Invalid at:// URI: ${uri}`);
  return [m[1], m[2], m[3]];
}

async function postResolution(alertRow, agentGetter) {
  const pseudoAlert = { headline: alertRow.headline };
  const text = buildResolutionReplyText({ alert: pseudoAlert, kind: KIND });

  if (DRY_RUN) {
    console.log(`--- DRY RUN resolution for alert ${alertRow.alert_id} ---\n${text}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }
  if (!alertRow.post_uri) {
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }

  const agent = await agentGetter();
  try {
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

async function main() {
  setup();
  const alerts = await fetchAlerts({ activeOnly: true });
  const relevant = alerts.filter(isRelevant);
  const activeIds = new Set(relevant.map((a) => a.id));

  console.log(`Fetched ${alerts.length} active alerts, ${relevant.length} relevant to tracked bus routes`);

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  for (const alert of relevant) {
    const existing = getAlertPost(alert.id);
    if (existing) {
      recordAlertSeen({ alertId: alert.id, kind: KIND, routes: alert.busRoutes.join(','), headline: alert.headline, postUri: null });
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
