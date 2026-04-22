// Ghost bus detection. Compares observed active bus count against
// `trip_duration / headway` — the number of buses that should be simultaneously
// active per direction to maintain the scheduled headway.

const MISSING_PCT_THRESHOLD = 0.25;  // ≥25% of expected active buses unaccounted for
const MISSING_ABS_THRESHOLD = 3;     // ...and ≥3 buses missing in absolute terms
const MIN_SNAPSHOTS = 8;             // at a 5-min cadence the window holds ~12; 8 tolerates ≤4 dropped polls
const MIN_OBSERVED = 2;              // observed ≥ 2 — "missing 7 of 9" with observed=0/1 is either a schedule bug or a genuine outage the gap bot already covers
const MAX_EXPECTED_ACTIVE = 30;      // sanity ceiling — expected > 30 almost always means a bad GTFS bucket (e.g. sub-minute median) slipped through

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

    // Resolve each unique pid to a pattern once. If any pid we actually have
    // observations for fails to resolve (fetch error, empty direction label,
    // etc.), skip the whole route — expectedActive still counts those trips
    // so dropping the observations alone would inflate `missing` and fire a
    // spurious ghost.
    const pids = [...new Set(obs.map((o) => o.direction).filter(Boolean))];
    const patternByPid = new Map();
    const failedPids = [];
    for (const pid of pids) {
      try {
        const p = await getPattern(pid);
        if (p && p.direction) patternByPid.set(pid, p);
        else failedPids.push(pid);
      } catch (e) {
        failedPids.push(pid);
        console.warn(`ghosts: pattern fetch failed for pid ${pid}: ${e.message}`);
      }
    }
    if (failedPids.length > 0) {
      console.warn(`ghosts: skipping route ${route} — unresolved pids with observations: ${failedPids.join(', ')}`);
      continue;
    }

    // Group observations by pattern.direction (the rider-facing label, e.g.
    // "Northbound"). Multiple pids can share a direction on routes with weekday/
    // express variants — merging is correct.
    const byDir = new Map(); // dirLabel → { obs: [...], pattern: <any sample> }
    for (const o of obs) {
      const pattern = patternByPid.get(o.direction);
      if (!pattern) continue;
      const label = pattern.direction;
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
      if (expectedActive > MAX_EXPECTED_ACTIVE) {
        console.warn(`ghosts: ${route}/${direction} expectedActive=${expectedActive.toFixed(1)} exceeds cap (${MAX_EXPECTED_ACTIVE}) — skipping, likely schedule-index bug`);
        continue;
      }

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
      if (observedActive < MIN_OBSERVED) continue;
      // Stddev > observed → per-snapshot counts are wildly inconsistent, which
      // usually means observer polling blackouts, not actually-missing vehicles.
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
      const stddev = Math.sqrt(variance);
      if (stddev > observedActive) continue;

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

module.exports = { detectBusGhosts, MISSING_PCT_THRESHOLD, MISSING_ABS_THRESHOLD, MIN_SNAPSHOTS, MIN_OBSERVED, MAX_EXPECTED_ACTIVE };
