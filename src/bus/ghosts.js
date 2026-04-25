// Compares observed active bus count against the scheduled active-trip count
// per hour. The ground-truth number of buses that should be simultaneously
// active per direction.

const MISSING_PCT_THRESHOLD = 0.25;
const MISSING_ABS_THRESHOLD = 3;
const MIN_SNAPSHOTS = 8;             // tolerates ≤4 dropped polls in a ~12-poll window
const MIN_OBSERVED = 2;              // observed=0/1 is either a schedule bug or a gap (already covered)
const MAX_EXPECTED_ACTIVE = 30;      // sanity ceiling — most likely a bad GTFS bucket
const RAMP_FILL_RATIO = 0.8;         // tail median ≥ this × expected → pipeline is filling, not ghosting
const RAMP_TAIL_FRACTION = 0.25;     // tail = last 25%, min 3

const { median } = require('../shared/stats');

// During AM ramp-up the full-window median lags reality but the tail tracks
// current service — used to gate against firing on a filling pipeline.
function tailMedian(perSnapshot) {
  const pairs = [...perSnapshot.entries()].sort((a, b) => a[0] - b[0]);
  const tailLen = Math.max(3, Math.ceil(pairs.length * RAMP_TAIL_FRACTION));
  const tail = pairs.slice(-tailLen).map(([, set]) => set.size);
  return median(tail);
}

async function detectBusGhosts({
  routes,
  getObservations,
  getPattern,
  expectedHeadway,
  expectedDuration,
  expectedActive,
}) {
  const events = [];

  for (const route of routes) {
    const obs = getObservations(route);
    if (obs.length === 0) continue;

    // Skip the whole route on any pattern resolution failure — expectedActive
    // still counts trips for that pid, so dropping observations alone would
    // inflate `missing` and fire a spurious ghost.
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

    // Group by rider-facing direction label so weekday/express pid variants merge.
    const byDir = new Map();
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
      const active = expectedActive(route, group.pattern);
      if (active == null || active <= 0) continue;
      // Headway/duration are display-only — null falls back to generic wording.

      // Sparse routes (active < 2) make ghost calls meaningless; one missing
      // bus isn't a story, two→zero is a gap (covered by the gaps bot).
      if (active < 2) continue;
      if (active > MAX_EXPECTED_ACTIVE) {
        console.warn(`ghosts: ${route}/${direction} expectedActive=${active.toFixed(1)} exceeds cap (${MAX_EXPECTED_ACTIVE}) — skipping, likely schedule-index bug`);
        continue;
      }

      const perSnapshot = new Map();
      for (const o of group.obs) {
        if (!perSnapshot.has(o.ts)) perSnapshot.set(o.ts, new Set());
        perSnapshot.get(o.ts).add(o.vehicle_id);
      }
      if (perSnapshot.size < MIN_SNAPSHOTS) continue;

      const counts = [...perSnapshot.values()].map((s) => s.size);
      const observedActive = median(counts);
      const missing = active - observedActive;
      if (missing < MISSING_ABS_THRESHOLD) continue;
      if (missing / active < MISSING_PCT_THRESHOLD) continue;
      if (observedActive < MIN_OBSERVED) continue;
      // Wildly inconsistent counts usually indicate polling blackouts, not real ghosts.
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
      const stddev = Math.sqrt(variance);
      if (stddev > observedActive) continue;
      // Ramp-up gate: a filled tail means the deficit is at the front of the
      // hour, not now. Real outages persist into the tail.
      if (tailMedian(perSnapshot) >= RAMP_FILL_RATIO * active) continue;

      events.push({
        route,
        direction,
        expectedActive: active,
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

module.exports = { detectBusGhosts, MISSING_PCT_THRESHOLD, MISSING_ABS_THRESHOLD, MIN_SNAPSHOTS, MIN_OBSERVED, MAX_EXPECTED_ACTIVE, RAMP_FILL_RATIO, RAMP_TAIL_FRACTION };
