// Detects route-level bus blackouts: a tracked route with zero distinct
// vehicles observed in the lookback while GTFS says the route should be
// running and other routes report normally. Pure function — no DB writes,
// no API calls; all I/O comes through injected callbacks. The bin script
// (`bin/bus/pulse.js`) handles persistence/cooldown/threading.
//
// The "strict zero" rule deliberately differs from the train detector. A
// route with even one bus on the air (including a stuck yard bus) suppresses
// the alert — gaps are the bus/gapPost.js channel's job, not pulse's.

const MIN_EXPECTED_ACTIVE = 2;
const MIN_OTHER_ROUTES_ACTIVE = 5;
const MIN_OTHER_DISTINCT_TS = 3;
const MIN_DISTINCT_TS = 3;
const LOOKBACK_FLOOR_MS = 25 * 60 * 1000;
const LOOKBACK_CEIL_MS = 60 * 60 * 1000;
// Below this expected-active value, an hour is considered scheduled-quiet
// for the lookback-window probe. activeByHour averages over the hour, so a
// peak-only route resuming service (e.g. X49 after the midday gap) shows
// expectedActive ≈ the hour's average within minute one — even though the
// first scheduled trip hasn't departed yet. Ghost detection's tail-median
// guard solves the same problem for partial-shortage signals; pulse's
// strict-zero signal needs a schedule-side guard since there are no
// observations to compare against.
const RAMP_PRIOR_ACTIVE_THRESHOLD = 1;
// Mirror image: in the last 30 min of the final hour of service, the hourly
// average overstates how many trips are still on the road, and the last
// scheduled departure may already be done. If the next hour has no
// scheduled service, suppress — the cold tail behind the last bus reads as
// a blackout but is just end-of-day shutdown.
const WIND_DOWN_NEXT_ACTIVE_THRESHOLD = 1;
const WIND_DOWN_MINUTE_THRESHOLD = 30;
const COLD_START_GRACE_MS = 6 * 60 * 60 * 1000;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

async function detectBusBlackouts({
  routes,
  routeNames,
  observationsByRoute,
  loadPattern,
  getKnownPidsForRoute,
  expectedRouteActive,
  expectedHeadway,
  globalDistinctTs,
  recentlyActiveRoutes,
  now,
  opts = {},
}) {
  const minExpectedActive = opts.minExpectedActive ?? MIN_EXPECTED_ACTIVE;
  const minOtherRoutesActive = opts.minOtherRoutesActive ?? MIN_OTHER_ROUTES_ACTIVE;
  const minOtherDistinctTs = opts.minOtherDistinctTs ?? MIN_OTHER_DISTINCT_TS;
  const minDistinctTs = opts.minDistinctTs ?? MIN_DISTINCT_TS;
  const lookbackFloorMs = opts.lookbackFloorMs ?? LOOKBACK_FLOOR_MS;
  const lookbackCeilMs = opts.lookbackCeilMs ?? LOOKBACK_CEIL_MS;
  const rampPriorActiveThreshold = opts.rampPriorActiveThreshold ?? RAMP_PRIOR_ACTIVE_THRESHOLD;
  const windDownNextActiveThreshold =
    opts.windDownNextActiveThreshold ?? WIND_DOWN_NEXT_ACTIVE_THRESHOLD;
  const windDownMinuteThreshold = opts.windDownMinuteThreshold ?? WIND_DOWN_MINUTE_THRESHOLD;
  const minuteOfHour = opts.minuteOfHour;

  // Accept either a Date or a millisecond timestamp. Tests pass a number;
  // production passes new Date(). Normalize once so downstream math/Date
  // construction is consistent.
  const nowMs = typeof now === 'number' ? now : now.getTime();
  if (!routes || routes.length === 0) {
    return { skipped: 'no-routes', candidates: [] };
  }
  if ((globalDistinctTs || 0) < minDistinctTs) {
    return { skipped: 'warming-up', candidates: [] };
  }

  // First pass: figure out which routes are "active" right now (≥ minOtherDistinctTs
  // distinct timestamps in the lookback). Used for the cross-route guard so a
  // pipeline-wide outage doesn't masquerade as a single-route blackout.
  const distinctTsByRoute = new Map();
  for (const route of routes) {
    const obs = observationsByRoute.get(String(route)) || [];
    distinctTsByRoute.set(String(route), new Set(obs.map((o) => o.ts)).size);
  }
  const activeRoutes = [...distinctTsByRoute.entries()].filter(
    ([, n]) => n >= minOtherDistinctTs,
  ).length;

  if (activeRoutes < minOtherRoutesActive) {
    return { skipped: 'pipeline-wide-quiet', candidates: [] };
  }

  const candidates = [];
  for (const route of routes) {
    const routeStr = String(route);
    const obs = observationsByRoute.get(routeStr) || [];

    // Pids from this lookback's observations, plus any historically-seen
    // pids the bin supplies via getKnownPidsForRoute. The fallback matters
    // for fully-silent routes — without it, a true blackout has no pids to
    // resolve a pattern from, so the route would be skipped.
    const observedPids = [...new Set(obs.map((o) => o.pid).filter(Boolean))];
    const knownPids = getKnownPidsForRoute ? (await getKnownPidsForRoute(routeStr)) || [] : [];
    const pids = [...new Set([...observedPids, ...knownPids])];
    const patterns = [];
    for (const pid of pids) {
      try {
        const p = await loadPattern(pid);
        if (p) patterns.push(p);
      } catch (_e) {
        /* skip individual pid failures — other pids may still resolve */
      }
    }
    if (patterns.length === 0) continue;

    // expectedRouteActive sums activeByHour across all GTFS directions of the
    // route once; do NOT sum per-pattern, since multiple patterns resolve to
    // the same direction and would multiply the value (e.g. 53A has 9 PIDs at
    // Sun 23:00 → per-pattern sum was ~9× the true 0.5, defeating the
    // MIN_EXPECTED_ACTIVE gate and the wind-down guard).
    const eaRoute = expectedRouteActive(routeStr, now);
    const expectedActiveSum = Number.isFinite(eaRoute) ? eaRoute : 0;
    let minHeadwayMin = null;
    let maxHeadwayMin = null;
    for (const pattern of patterns) {
      const h = expectedHeadway(routeStr, pattern, now);
      if (Number.isFinite(h) && h > 0) {
        if (minHeadwayMin == null || h < minHeadwayMin) minHeadwayMin = h;
        if (maxHeadwayMin == null || h > maxHeadwayMin) maxHeadwayMin = h;
      }
    }

    if (expectedActiveSum < minExpectedActive) continue;

    // Cold-start grace: if the route has had ZERO observations across the
    // entire grace window (default 6h), this is service-not-yet-started, not
    // a blackout. Mirrors the train-side fix; catches early-morning ramp-up
    // FPs where the GTFS hour says service should have begun but the first
    // bus hadn't pulled out of the garage yet (e.g. route 50 today: alert
    // posted at 5:08, first observation at 5:10).
    if (recentlyActiveRoutes && !recentlyActiveRoutes.has(routeStr)) {
      console.log(
        `bus-pulse: skipping ${routeStr} — cold-start grace (no observations in past ${Math.round((opts.coldStartGraceMs ?? COLD_START_GRACE_MS) / 60_000)} min)`,
      );
      continue;
    }

    // Headway-scaled lookback computed below — but we need it here for the
    // ramp guard, so derive it ahead of the observation slice.
    const guardLookbackMs =
      maxHeadwayMin != null
        ? clamp(3 * maxHeadwayMin * 60_000, lookbackFloorMs, lookbackCeilMs)
        : lookbackFloorMs;

    // Lookback-window quiet-edge guard: sample the schedule at the start and
    // midpoint of the lookback window. If either sample falls in a
    // scheduled-quiet hour, the cold tail behind that quiet period reads as
    // a blackout but is really just a quiet→active transition the
    // observation window happened to straddle. Subsumes:
    //   - dawn ramp-up (lookback starts before service begins)
    //   - first-trip-of-day delays (first scheduled trip late but the prior
    //     hour was already quiet, so the window still straddles a transition)
    //   - inter-peak gaps mid-lookback (midpoint sample lands in the gap)
    //   - post-midday-gap ramp (e.g. #2 Hyde Park Express resuming PM rush)
    const lookbackQuietProbe = (() => {
      const samples = [new Date(nowMs - guardLookbackMs), new Date(nowMs - guardLookbackMs / 2)];
      for (const t of samples) {
        const ea = expectedRouteActive(routeStr, t);
        const active = Number.isFinite(ea) ? ea : 0;
        if (active < rampPriorActiveThreshold) {
          return { quiet: true, active, at: t };
        }
      }
      return { quiet: false };
    })();
    if (lookbackQuietProbe.quiet) {
      console.log(
        `bus-pulse: skipping ${routeStr} — lookback window straddles scheduled-quiet (active=${lookbackQuietProbe.active.toFixed(1)} at ${lookbackQuietProbe.at.toISOString()})`,
      );
      continue;
    }

    // Wind-down guard: in the last half of the final hour of service, the
    // hourly average overstates remaining service. If the next hour has no
    // scheduled trips, the cold tail reads as a blackout but is just the
    // route shutting down for the night.
    if (minuteOfHour != null && minuteOfHour >= 60 - windDownMinuteThreshold) {
      const nextWhen = new Date(nowMs + 60 * 60 * 1000);
      const eaNext = expectedRouteActive(routeStr, nextWhen);
      const nextActiveSum = Number.isFinite(eaNext) ? eaNext : 0;
      if (nextActiveSum < windDownNextActiveThreshold) {
        console.log(
          `bus-pulse: skipping ${routeStr} — wind-down (next-hour active=${nextActiveSum.toFixed(1)}, minute=${minuteOfHour})`,
        );
        continue;
      }
    }

    // Headway-scaled lookback: 3× longest direction's headway, clamped.
    // Identical to the guard-side lookback above.
    const lookbackMs = guardLookbackMs;
    const sinceTs = nowMs - lookbackMs;
    const inWindow = obs.filter((o) => o.ts >= sinceTs);
    const distinctVids = new Set(inWindow.map((o) => o.vid).filter(Boolean));

    if (distinctVids.size > 0) continue;

    candidates.push({
      route: routeStr,
      name: routeNames?.[routeStr] || routeStr,
      lookbackMin: Math.round(lookbackMs / 60_000),
      minHeadwayMin,
      expectedActive: expectedActiveSum,
    });
  }

  return { skipped: null, candidates };
}

module.exports = {
  detectBusBlackouts,
  MIN_EXPECTED_ACTIVE,
  MIN_OTHER_ROUTES_ACTIVE,
  MIN_OTHER_DISTINCT_TS,
  MIN_DISTINCT_TS,
  LOOKBACK_FLOOR_MS,
  LOOKBACK_CEIL_MS,
  RAMP_PRIOR_ACTIVE_THRESHOLD,
  WIND_DOWN_NEXT_ACTIVE_THRESHOLD,
  WIND_DOWN_MINUTE_THRESHOLD,
  COLD_START_GRACE_MS,
};
