#!/usr/bin/env node
// Bus pulse — observation-based bus blackout detector. Posts when a tracked
// route has zero distinct vehicles observed in the lookback while GTFS says
// the route should be running and other routes are reporting normally.
//
// Strict-zero gate (vs train pulse's segment binning): even one bus on the
// air suppresses the alert. Gaps are bin/bus/gapPost.js's channel — pulse
// only fires on a "truly nothing running" blackout.
//
// PULSE_DRY_RUN=1 / --dry-run: skip posting + DB writes (recommended for
// any deploy that touches detector logic).

require('../../src/shared/env');

const { setup, runBin } = require('../../src/shared/runBin');
const { detectBusBlackouts } = require('../../src/bus/pulse');
const { detectHeldBusClusters } = require('../../src/bus/heldClusters');
const { allRoutes: pulseRoutes, names: routeNames } = require('../../src/bus/routes');
const { loadPattern } = require('../../src/bus/patterns');
const { getVehiclesCachedOrFresh } = require('../../src/bus/api');
const {
  loginAlerts,
  postText,
  postWithImage,
  resolveReplyRef,
} = require('../../src/shared/bluesky');
const { renderBusDisruptionRich } = require('../../src/map');
const {
  buildBusPostText,
  buildBusClearPostText,
  buildBusHeldPostText,
} = require('../../src/shared/disruption');
const {
  expectedHeadwayMin,
  expectedActiveTrips,
  chicagoMinuteOfHour,
} = require('../../src/shared/gtfs');
const {
  getRecentBusObservationsByRoute,
  countDistinctTsInBusObservations,
  getActiveBusRoutesSince,
  rolloffOldObservations,
} = require('../../src/shared/observations');
const { acquireCooldown, clearCooldown } = require('../../src/shared/state');
const {
  getBusPulseState,
  upsertBusPulseState,
  clearBusPulseState,
  recordDisruption,
  hasObservedClearForPulse,
  hasUnresolvedCtaAlert,
  getDb,
  recordMetaSignal,
} = require('../../src/shared/history');

const DRY_RUN = process.env.BUS_PULSE_DRY_RUN === '1' || process.argv.includes('--dry-run');

const MIN_CONSECUTIVE_TICKS = 2;
const CLEAR_TICKS_TO_RESET = 3;
const POST_COOLDOWN_MS = 90 * 60 * 1000;
const MIN_HOUR = 5;
const MAX_HOUR = 24;
const POLL_LOOKBACK_MS = 60 * 60 * 1000; // upper bound for observation window
const KNOWN_PIDS_LOOKBACK_MS = 48 * 60 * 60 * 1000; // matches obs rolloff

function chicagoHourNow(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hourCycle: 'h23',
    hour: '2-digit',
  }).format(now);
  return parseInt(h, 10) % 24;
}

async function buildBusPulseImage({ route, candidate, isHeld }) {
  try {
    if (isHeld && candidate.pid != null) {
      // Held cluster: load the affected pid only and pin the cluster centroid.
      const pattern = await loadPattern(candidate.pid);
      if (!pattern) return null;
      const halfWidth = Math.max(660, (candidate.clusterHiFt - candidate.clusterLoFt) / 2 + 660);
      // In-image title uses ⚠ instead of 🚨 because librsvg's font fallback on
      // the server doesn't carry color-emoji glyphs and 🚨 renders as an empty
      // box. The post body keeps the 🚨 (Bluesky renders it natively).
      const title = `⚠ #${route} ${routeNames[route] || ''}: ${candidate.busCount} bus${
        candidate.busCount === 1 ? '' : 'es'
      } stuck`.trim();
      return await renderBusDisruptionRich({
        route,
        pattern,
        focusZone: { centerPdist: candidate.clusterMidFt, halfWidthFt: halfWidth },
        title,
        mode: 'held',
      });
    }
    // Blackout: pick the longest known pattern as a representative trace.
    const pids = getKnownPidsForRoute(route, Date.now());
    if (pids.length === 0) return null;
    let canonical = null;
    for (const pid of pids) {
      try {
        const p = await loadPattern(pid);
        if (p && (!canonical || (p.points?.length || 0) > (canonical.points?.length || 0))) {
          canonical = p;
        }
      } catch (_e) {}
    }
    if (!canonical) return null;
    const title = `⚠ #${route} ${routeNames[route] || ''} service appears suspended`.trim();
    return await renderBusDisruptionRich({
      route,
      pattern: canonical,
      focusZone: null,
      title,
      mode: 'blackout',
    });
  } catch (e) {
    console.warn(`buildBusPulseImage failed for ${route}: ${e.message}`);
    return null;
  }
}

function buildBusPulseAlt({ route, candidate, isHeld }) {
  const name = routeNames[route] || route;
  if (isHeld) {
    const minutes = Math.round((candidate.stationaryMs || 0) / 60000);
    return `Map of #${route} ${name}, with the route dimmed except a highlighted segment where ${candidate.busCount} bus${candidate.busCount === 1 ? '' : 'es'} have been stationary ${minutes}+ min. A red pin marks the centroid of the stuck cluster.`;
  }
  return `Map of #${route} ${name} dimmed end-to-end to indicate the route appears to have no buses in service. Both terminals are labeled.`;
}

function getKnownPidsForRoute(route, now) {
  const sinceTs = now - KNOWN_PIDS_LOOKBACK_MS;
  const rows = getDb()
    .prepare(`
      SELECT DISTINCT direction AS pid
      FROM observations
      WHERE kind = 'bus' AND route = ? AND ts >= ? AND direction IS NOT NULL
    `)
    .all(String(route), sinceTs);
  return rows.map((r) => r.pid);
}

async function handleCandidate(candidate, agentGetter, now) {
  const route = candidate.route;
  const isHeld = candidate.kind === 'held';
  const prior = getBusPulseState(route);
  const consecutive = (prior?.consecutive_ticks || 0) + 1;
  const startedTs = prior?.started_ts || now;
  const cooldownKey = `bus_pulse_${route}`;
  const activePostUri = prior?.active_post_uri || null;
  const activePostTs = prior?.active_post_ts || null;

  upsertBusPulseState({
    route,
    startedTs,
    lastSeenTs: now,
    consecutiveTicks: consecutive,
    clearTicks: 0,
    postedCooldownKey: cooldownKey,
    activePostUri,
    activePostTs,
  });

  if (activePostUri) {
    console.log(
      `[bus/${route}] active pulse ${activePostUri} still in effect — refreshing state, no re-post`,
    );
    return;
  }

  if (consecutive < MIN_CONSECUTIVE_TICKS) {
    console.log(
      `[bus/${route}] ${isHeld ? 'held' : 'blackout'} candidate tick ${consecutive}/${MIN_CONSECUTIVE_TICKS}`,
    );
    recordMetaSignal({
      kind: 'bus',
      line: route,
      direction: candidate.pid || null,
      source: isHeld ? 'pulse-held' : 'pulse-cold',
      severity: 0.5,
      detail: { route, kind: candidate.kind || 'cold' },
      posted: false,
    });
    return;
  }

  const ctaAlertOpenInitial = !!hasUnresolvedCtaAlert({ kind: 'bus', ctaRouteCode: route });

  if (DRY_RUN) {
    const text = isHeld
      ? buildBusHeldPostText(
          { route, name: routeNames[route] || route, candidate },
          { ctaAlertOpen: ctaAlertOpenInitial },
        )
      : buildBusPostText(candidate, { ctaAlertOpen: ctaAlertOpenInitial });
    console.log(`--- DRY RUN bus pulse ${route} (${isHeld ? 'held' : 'blackout'}) ---\n${text}`);
    recordDisruption({
      kind: 'bus',
      line: route,
      direction: null,
      fromStation: null,
      toStation: null,
      source: isHeld ? 'observed-held' : 'observed',
      posted: false,
      postUri: null,
    });
    return;
  }

  if (!acquireCooldown(cooldownKey, now, POST_COOLDOWN_MS)) {
    console.log(`[bus/${route}] on cooldown ${cooldownKey}, skipping`);
    recordDisruption({
      kind: 'bus',
      line: route,
      direction: null,
      fromStation: null,
      toStation: null,
      source: isHeld ? 'observed-held' : 'observed',
      posted: false,
      postUri: null,
    });
    return;
  }

  const agent = await agentGetter();
  const replyRef = await findOpenAlertReplyRefBus(agent, route);
  const ctaAlertOpen = !!replyRef || ctaAlertOpenInitial;
  const text = isHeld
    ? buildBusHeldPostText({ route, name: routeNames[route] || route, candidate }, { ctaAlertOpen })
    : buildBusPostText(candidate, { ctaAlertOpen });

  // Render a route map: held posts pin the cluster + dim everything outside
  // it; blackouts dim the whole route + label terminals. Falls back to
  // text-only on any render error.
  const image = await buildBusPulseImage({ route, candidate, isHeld });
  const alt = image ? buildBusPulseAlt({ route, candidate, isHeld }) : null;

  const result = image
    ? await postWithImage(agent, text, image, alt, replyRef)
    : await postText(agent, text, replyRef);
  console.log(`Posted bus pulse ${route}: ${result.url}`);
  recordDisruption({
    kind: 'bus',
    line: route,
    direction: null,
    fromStation: null,
    toStation: null,
    source: isHeld ? 'observed-held' : 'observed',
    posted: true,
    postUri: result.uri,
  });
  upsertBusPulseState({
    route,
    startedTs,
    lastSeenTs: now,
    consecutiveTicks: consecutive,
    clearTicks: 0,
    postedCooldownKey: cooldownKey,
    activePostUri: result.uri,
    activePostTs: now,
  });
}

async function handleClear(route, agentGetter, now) {
  const prior = getBusPulseState(route);
  if (!prior) return;
  const clearTicks = (prior.clear_ticks || 0) + 1;
  if (clearTicks >= CLEAR_TICKS_TO_RESET) {
    console.log(`[bus/${route}] cleared after ${clearTicks} clean ticks`);
    await postClearReply(route, prior, agentGetter);
    if (prior.posted_cooldown_key) clearCooldown(prior.posted_cooldown_key);
    clearBusPulseState(route);
    return;
  }
  upsertBusPulseState({
    route,
    startedTs: prior.started_ts,
    lastSeenTs: now,
    consecutiveTicks: prior.consecutive_ticks,
    clearTicks,
    postedCooldownKey: prior.posted_cooldown_key,
    activePostUri: prior.active_post_uri,
    activePostTs: prior.active_post_ts,
  });
}

async function postClearReply(route, prior, agentGetter) {
  if (!prior?.active_post_uri) return;
  if (hasObservedClearForPulse({ kind: 'bus', pulseUri: prior.active_post_uri })) {
    console.log(
      `[bus/${route}] clear reply already posted for ${prior.active_post_uri} — skipping`,
    );
    return;
  }
  const ctaAlertOpen = !!hasUnresolvedCtaAlert({ kind: 'bus', ctaRouteCode: route });
  const name = routeNames[route] || route;
  const text = buildBusClearPostText({ route, name }, { ctaAlertOpen });

  if (DRY_RUN) {
    console.log(`--- DRY RUN bus pulse clear ${route} ---\n${text}`);
    return;
  }

  const agent = await agentGetter();
  // Thread the ✅ under the most recent open CTA alert in the thread when one
  // joined; falls back to the original pulse post when no CTA alert is in the
  // thread. resolveReplyRef walks up the chain so root stays the pulse post.
  const replyRef =
    (await findOpenAlertReplyRefBus(agent, route)) ||
    (await resolveReplyRef(agent, prior.active_post_uri));
  if (!replyRef) {
    console.warn(`[bus/${route}] could not resolve reply ref for clear post`);
    return;
  }
  const result = await postText(agent, text, replyRef);
  console.log(`Posted bus pulse clear ${route}: ${result.url}`);
  recordDisruption({
    kind: 'bus',
    line: route,
    direction: null,
    fromStation: null,
    toStation: null,
    source: 'observed-clear',
    posted: true,
    postUri: result.uri,
  });
}

// Find the most relevant open CTA bus alert on this route to thread under.
// Mirrors bin/train/pulse.js#findOpenAlertReplyRef but route-match scored —
// the alert's `routes` column carries comma-joined route codes from
// bin/bus/alerts.js#postNewAlert.
async function findOpenAlertReplyRefBus(agent, route) {
  const rows = getDb()
    .prepare(`
      SELECT post_uri FROM alert_posts
      WHERE kind = 'bus' AND resolved_ts IS NULL
        AND post_uri IS NOT NULL
        AND (',' || routes || ',') LIKE ?
      ORDER BY first_seen_ts DESC LIMIT 1
    `)
    .get(`%,${route},%`);
  if (!rows) return null;
  return resolveReplyRef(agent, rows.post_uri);
}

async function main() {
  setup();
  const now = Date.now();
  console.log(
    `bus-pulse: scanning ${pulseRoutes.length} routes for strict-zero blackouts ` +
      `(reads observations table written by observe-buses; posts after ${MIN_CONSECUTIVE_TICKS} consecutive ticks, ` +
      `clears after ${CLEAR_TICKS_TO_RESET} clean ticks; only fires when route is fully silent and ≥5 other routes report normally)`,
  );
  const hour = chicagoHourNow(new Date(now));
  if (hour < MIN_HOUR || hour >= MAX_HOUR) {
    console.log(`bus-pulse: skipping outside ${MIN_HOUR}–${MAX_HOUR} CT (hour=${hour})`);
    return;
  }

  rolloffOldObservations();

  // Fresh poll if cache is stale — observeBuses runs */5 in parallel, so
  // most ticks reuse its snapshot.
  try {
    await getVehiclesCachedOrFresh(pulseRoutes);
  } catch (e) {
    console.warn(`bus pulse: getVehicles failed: ${e.message}`);
  }

  const sinceTs = now - POLL_LOOKBACK_MS;
  const observationsByRoute = getRecentBusObservationsByRoute(pulseRoutes, sinceTs);
  const globalDistinctTs = countDistinctTsInBusObservations(sinceTs);
  // Cold-start grace window: routes with at least one observation in the past
  // 6 hours are eligible for blackout detection. Routes that haven't been
  // seen at all today are likely just service-not-yet-started.
  const COLD_START_GRACE_MS = 6 * 60 * 60 * 1000;
  const recentlyActiveRoutes = getActiveBusRoutesSince(now - COLD_START_GRACE_MS);

  const detection = await detectBusBlackouts({
    routes: pulseRoutes,
    routeNames,
    observationsByRoute,
    loadPattern,
    getKnownPidsForRoute: (route) => getKnownPidsForRoute(route, now),
    expectedActive: (route, pattern, when) => expectedActiveTrips(route, pattern, when),
    expectedHeadway: (route, pattern, when) => expectedHeadwayMin(route, pattern, when),
    globalDistinctTs,
    recentlyActiveRoutes,
    now: new Date(now),
    opts: { minuteOfHour: chicagoMinuteOfHour(new Date(now)) },
  });

  if (detection.skipped) {
    const reasonProse =
      {
        'no-routes': 'no tracked routes configured',
        'warming-up': `only ${globalDistinctTs} distinct snapshot(s) in observations table — observe-buses warming up`,
        'pipeline-wide-quiet':
          'fewer than 5 routes reporting normally (cross-route guard) — likely an upstream API/observe-buses issue, not a route-specific blackout',
      }[detection.skipped] || detection.skipped;
    console.log(`bus-pulse: skipped — ${reasonProse}`);
    return;
  }

  const routesWithObs = [...observationsByRoute.values()].filter((arr) => arr.length > 0).length;
  console.log(
    `bus-pulse: evaluated ${pulseRoutes.length} routes, ${routesWithObs} with recent observations, ` +
      `${pulseRoutes.length - routesWithObs} silent → ${detection.candidates.length} strict-zero candidate(s) ` +
      '(routes that passed the GTFS expected-active gate AND had zero distinct vehicles in headway-scaled lookback)',
  );

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  const candidateRoutes = new Set(detection.candidates.map((c) => c.route));

  // Held-cluster pass — runs over the same observation set. Buses present
  // but not advancing (e.g. police hold blocking the route) are invisible
  // to the strict-zero blackout detector.
  const heldCandidates = [];
  if (process.env.HELD_DETECTION !== '0') {
    for (const route of pulseRoutes) {
      const obs = observationsByRoute.get(String(route)) || [];
      if (obs.length === 0) continue;
      let headwayMin = null;
      try {
        headwayMin = expectedHeadwayMin(route, null, new Date(now));
      } catch (_e) {
        headwayMin = null;
      }
      // Load pattern lengths for every pid present in this route's obs so
      // the detector can suppress terminal layovers + require moving-veto
      // headroom. Patterns are file-cached by loadPattern.
      const pidsInObs = new Set();
      for (const o of obs) if (o.direction != null) pidsInObs.add(String(o.direction));
      const patternLengthByPid = new Map();
      for (const pid of pidsInObs) {
        try {
          const pattern = await loadPattern(pid);
          if (pattern && Number.isFinite(pattern.lengthFt)) {
            patternLengthByPid.set(pid, pattern.lengthFt);
          }
        } catch (_e) {}
      }
      try {
        const out = detectHeldBusClusters({
          route,
          observations: obs,
          headwayMin,
          patternLengthByPid,
          now,
        });
        for (const c of out.candidates) {
          heldCandidates.push({ ...c, kind: 'held', route });
        }
      } catch (e) {
        console.error(`held bus detect failed for ${route}: ${e.stack || e.message}`);
      }
    }
    if (heldCandidates.length > 0) {
      console.log(
        `bus-pulse: held-cluster detection emitted ${heldCandidates.length} candidate(s) across ${new Set(heldCandidates.map((c) => c.route)).size} route(s)`,
      );
    }
  }

  // Sort held > blackout for same route so handleCandidate's per-route
  // pulse_state gets the more specific signal.
  const allCandidates = [...detection.candidates, ...heldCandidates];
  allCandidates.sort((a, b) => (b.kind === 'held' ? 1 : 0) - (a.kind === 'held' ? 1 : 0));
  const seenRoutes = new Set();
  for (const candidate of allCandidates) {
    if (seenRoutes.has(candidate.route)) continue;
    seenRoutes.add(candidate.route);
    candidateRoutes.add(candidate.route);
    try {
      await handleCandidate(candidate, agentGetter, now);
    } catch (e) {
      console.error(`handleCandidate failed for bus/${candidate.route}: ${e.stack || e.message}`);
    }
  }

  // Clear sweep — any pulse_state row whose route is no longer a candidate.
  const stateRows = getDb().prepare('SELECT route FROM bus_pulse_state').all();
  for (const row of stateRows) {
    if (!candidateRoutes.has(row.route)) {
      try {
        await handleClear(row.route, agentGetter, now);
      } catch (e) {
        console.error(`handleClear failed for bus/${row.route}: ${e.stack || e.message}`);
      }
    }
  }
}

module.exports = { chicagoHourNow };

if (require.main === module) runBin(main);
