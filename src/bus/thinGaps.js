// Thin-gap detector for low-frequency bus routes.
//
// The existing observation-based detectors (ghosts/gaps/bunching/pulse) are
// tuned for the high-frequency network and are structurally blind to
// low-frequency routes — ghosts' MISSING_ABS_THRESHOLD=3 plus MIN_OBSERVED=2
// makes it mathematically impossible to fire on routes with ≤4 expected active
// buses, bunching needs ≥2 vehicles co-located, and pulse's MIN_EXPECTED_ACTIVE
// gates out thin service entirely. As a result every roundup ever posted is on
// a route already in the curated `gaps` list — sustained service failures on
// thin routes go completely unreported.
//
// This detector asks a simple binary question per eligible route: has *any*
// bus been observed in the past max(2 × scheduled headway, 60 min)? If not,
// and at least 2 scheduled trips should have completed in that window, fire.
// It catches the severe end (route effectively stopped running). Moderate
// slowdowns are intentionally out of scope — those need trip-level
// scheduled-vs-observed comparison and a much larger model.

const ABS_FLOOR_MIN = 60;
const HEADWAY_MULTIPLIER = 2;
const MIN_MISSED_TRIPS = 2;
const SEVERITY_NORMALIZER = 3; // severity = min(1, missed/3)

function detectThinGaps({
  routes,
  getObservations,
  getHeadway,
  getActiveTrips,
  now = Date.now(),
  onDrop,
}) {
  const events = [];
  const drop = (reason, info) => {
    if (onDrop) onDrop({ reason, ...info });
  };

  for (const route of routes) {
    const ctx = { route };
    const active = getActiveTrips(route);
    if (active == null || active <= 0) {
      drop('not_scheduled', { ...ctx, active });
      continue;
    }
    const headwayMin = getHeadway(route);
    if (headwayMin == null || headwayMin <= 0) {
      drop('no_headway', { ...ctx });
      continue;
    }

    const windowMin = Math.max(HEADWAY_MULTIPLIER * headwayMin, ABS_FLOOR_MIN);
    const windowMs = windowMin * 60_000;
    const missedTrips = Math.floor(windowMin / headwayMin);
    if (missedTrips < MIN_MISSED_TRIPS) {
      // Should never trigger given the ABS_FLOOR_MIN + headway > 15 eligibility,
      // but guarded so a misconfigured caller can't fire on a 1-trip window.
      drop('window_too_short', { ...ctx, headwayMin, windowMin, missedTrips });
      continue;
    }

    const since = now - windowMs;
    const obs = getObservations(route, since);
    if (obs && obs.length > 0) {
      drop('observed', { ...ctx, count: obs.length });
      continue;
    }

    events.push({
      route,
      headwayMin,
      windowMin,
      missedTrips,
      severity: Math.min(1, missedTrips / SEVERITY_NORMALIZER),
    });
  }

  return events;
}

module.exports = {
  detectThinGaps,
  ABS_FLOOR_MIN,
  HEADWAY_MULTIPLIER,
  MIN_MISSED_TRIPS,
};
