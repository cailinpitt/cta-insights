#!/usr/bin/env node
// Bus alerts post a route-overview map (bus reroutes don't map onto a
// from→to polyline segment the way rail outages do, so the image just shows
// the affected route polylines highlighted on a Chicago basemap — a rider's
// "is this me?" cue). Falls back to text-only when patterns can't be
// rendered (route never observed, multi-route over the URL cap, etc.).
//
// When a recent bus pulse post exists for any of the alert's routes, the
// CTA alert threads under it so all signals about one disruption converge
// to a single thread. Symmetric to bin/train/alerts.js.

require('../../src/shared/env');

const { setup, runBin } = require('../../src/shared/runBin');
const { fetchAlerts, isSignificantAlert } = require('../../src/shared/ctaAlerts');
const {
  loginAlerts,
  postText,
  postWithImage,
  resolveReplyRef,
} = require('../../src/shared/bluesky');
const {
  buildAlertPostText,
  buildBusAlertAltText,
  buildResolutionReplyText,
} = require('../../src/shared/alertPost');
const {
  getAlertPost,
  recordAlertSeen,
  recordAlertResolved,
  incrementAlertClearTicks,
  resetAlertClearTicks,
  listUnresolvedAlerts,
  getRecentPulsePostsAll,
  ALERT_CLEAR_TICKS,
} = require('../../src/shared/history');
const { getKnownBusPidsForRoute } = require('../../src/shared/observations');
const { renderBusDisruption, MAX_ROUTES } = require('../../src/map');
const { loadPattern } = require('../../src/bus/patterns');
const busRoutes = require('../../src/bus/routes');

const KNOWN_PIDS_LOOKBACK_MS = 48 * 60 * 60 * 1000;

const PULSE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const DRY_RUN = process.env.ALERTS_DRY_RUN === '1' || process.argv.includes('--dry-run');
const KIND = 'bus';

// Filter to every CTA bus route in `names`. The significance filter in
// ctaAlerts.js does the real gating — minor reroutes and bus-stop changes
// don't make it through — so narrowing to bunching/gaps/speedmap/ghosts
// just dropped major disruptions on long-tail routes.
const TRACKED = new Set(Object.keys(busRoutes.names));

function isRelevant(alert) {
  if (!isSignificantAlert(alert)) return false;
  return alert.busRoutes.some((r) => TRACKED.has(r));
}

// Find the most recent bus pulse post on any of the alert's routes so the
// CTA alert can thread under it. Bus pulse posts are per-route — no
// station-overlap scoring needed; just take the most-recent across all
// matching routes.
function findRecentBusPulse(alert, now = Date.now()) {
  let best = null;
  for (const route of alert.busRoutes) {
    const pulses = getRecentPulsePostsAll(
      { kind: KIND, line: route, withinMs: PULSE_LOOKBACK_MS },
      now,
    );
    for (const p of pulses) {
      if (!best || p.ts > best.ts) best = p;
    }
  }
  return best;
}

async function buildAlertImage(alert) {
  const trackedRoutes = alert.busRoutes.filter((r) => TRACKED.has(r));
  if (trackedRoutes.length === 0 || trackedRoutes.length > MAX_ROUTES) return null;
  const sinceTs = Date.now() - KNOWN_PIDS_LOOKBACK_MS;
  const title = buildBusMapTitle(trackedRoutes);
  try {
    return await renderBusDisruption({
      routes: trackedRoutes,
      getKnownPidsForRoute: (route) => getKnownBusPidsForRoute(route, sinceTs),
      loadPattern,
      title,
    });
  } catch (e) {
    console.warn(`renderBusDisruption failed for alert ${alert.id}: ${e.message}`);
    return null;
  }
}

function buildBusMapTitle(routes) {
  if (routes.length === 1) return `⚠ Route ${routes[0]} · service alert`;
  return `⚠ Routes ${routes.join(', ')} · service alert`;
}

async function postNewAlert(alert, agentGetter) {
  const text = buildAlertPostText({ alert, kind: KIND });
  const routes = alert.busRoutes.join(',');
  const image = await buildAlertImage(alert);
  const alt = image
    ? buildBusAlertAltText({
        alert,
        routes: alert.busRoutes.filter((r) => TRACKED.has(r)),
      })
    : null;

  if (DRY_RUN) {
    console.log(
      `--- DRY RUN alert ${alert.id} (DB write skipped) ---\n${text}\n\nAlt: ${alt || '(no image)'}\nImage: ${image ? `${image.length} bytes` : '(text-only fallback)'}`,
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

  let replyRef = null;
  const pulse = findRecentBusPulse(alert);
  if (pulse) replyRef = await resolveReplyRef(agent, pulse.post_uri);

  const result = image
    ? await postWithImage(agent, text, image, alt, replyRef)
    : await postText(agent, text, replyRef);
  console.log(
    `Posted alert ${alert.id}${replyRef ? ' (threaded under bus pulse)' : ''}${image ? ' [with map]' : ''}: ${result.url}`,
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
  const relevant = alerts.filter(isRelevant);
  const activeIds = new Set(relevant.map((a) => a.id));

  console.log(
    `Fetched ${alerts.length} active alerts, ${relevant.length} relevant to tracked bus routes`,
  );

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
          routes: alert.busRoutes.join(','),
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
