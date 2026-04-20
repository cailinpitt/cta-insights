// Ghost bus detection. Compares observed active bus count against
// `trip_duration / headway` — the number of buses that should be simultaneously
// active per direction to maintain the scheduled headway.

const MISSING_PCT_THRESHOLD = 0.25;  // ≥25% of expected active buses unaccounted for
const MISSING_ABS_THRESHOLD = 3;     // ...and ≥3 buses missing in absolute terms
const MIN_SNAPSHOTS = 6;             // require ≥6 poll snapshots in the window; below that, coverage is too sparse

const { median } = require('../shared/stats');

/**
 * Detect ghost buses for a set of routes over a time window.
 *
 * Dependencies are injected so this module can be tested without hitting the
 * DB, filesystem, or CTA API:
 *   - `getObservations(route)` → [{ ts, direction (pid), vehicle_id, ... }]
 *   - `getPattern(pid)` async → pattern object (has `direction` label)
 *   - `expectedHeadway(route, pattern)` → minutes or null
 *   - `expectedDuration(route, pattern)` → minutes or null
 *
 * Returns ghost events sorted by `missing` descending.
 */
async function detectBusGhosts({
  routes,
  getObservations,
  getPattern,
  expectedHeadway,
  expectedDuration,
}) {
  const events = [];

  for (const route of routes) {
    const obs = getObservations(route);
    if (obs.length === 0) continue;

    // Resolve each unique pid to a pattern once.
    const pids = [...new Set(obs.map((o) => o.direction).filter(Boolean))];
    const patternByPid = new Map();
    for (const pid of pids) {
      try {
        const p = await getPattern(pid);
        if (p) patternByPid.set(pid, p);
      } catch (e) {
        console.warn(`ghosts: pattern fetch failed for pid ${pid}: ${e.message}`);
      }
    }

    // Group observations by pattern.direction (the rider-facing label, e.g.
    // "Northbound"). Multiple pids can share a direction on routes with weekday/
    // express variants — merging is correct.
    const byDir = new Map(); // dirLabel → { obs: [...], pattern: <any sample> }
    for (const o of obs) {
      const pattern = patternByPid.get(o.direction);
      if (!pattern) continue;
      const label = pattern.direction;
      if (!label) continue;
      if (!byDir.has(label)) byDir.set(label, { obs: [], pattern });
      byDir.get(label).obs.push(o);
    }

    for (const [direction, group] of byDir) {
      const headway = expectedHeadway(route, group.pattern);
      const duration = expectedDuration(route, group.pattern);
      if (headway == null || duration == null || headway <= 0 || duration <= 0) continue;

      const expectedActive = duration / headway;
      // Even at full service you'd typically see ≥2 buses active per direction.
      // Routes with expected < ~2 are too sparse to make ghost calls meaningfully
      // (one missing bus isn't a story; two dropping to zero is a gap, which the
      // gaps bot already covers).
      if (expectedActive < 2) continue;

      // Count distinct vids per snapshot (ts). API returns all active vehicles
      // in one shot, so each ts gives a clean snapshot of active buses.
      const perSnapshot = new Map(); // ts → Set<vid>
      for (const o of group.obs) {
        if (!perSnapshot.has(o.ts)) perSnapshot.set(o.ts, new Set());
        perSnapshot.get(o.ts).add(o.vehicle_id);
      }
      if (perSnapshot.size < MIN_SNAPSHOTS) continue;

      const counts = [...perSnapshot.values()].map((s) => s.size);
      const observedActive = median(counts);
      const missing = expectedActive - observedActive;
      if (missing < MISSING_ABS_THRESHOLD) continue;
      if (missing / expectedActive < MISSING_PCT_THRESHOLD) continue;

      events.push({
        route,
        direction,
        expectedActive,
        observedActive,
        missing,
        snapshots: perSnapshot.size,
        headway,
        duration,
      });
    }
  }

  events.sort((a, b) => b.missing - a.missing);
  return events;
}

module.exports = { detectBusGhosts, MISSING_PCT_THRESHOLD, MISSING_ABS_THRESHOLD, MIN_SNAPSHOTS };
