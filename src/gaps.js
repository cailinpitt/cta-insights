const STALE_MS = 3 * 60 * 1000;
const TERMINAL_PDIST_FT = 1500;
// Convert pdist-feet to a time estimate. Typical in-city bus speed sits around
// 10 mph ≈ 880 ft/min once stops/signals are factored in. A crude conversion
// but we only use it to filter on a ratio vs. GTFS-scheduled headway — not an
// absolute ETA.
const TYPICAL_SPEED_FT_PER_MIN = 880;
// Flag a gap when observed time-gap exceeds this multiple of scheduled headway,
// AND exceeds the absolute floor (so low-frequency routes with 30-min schedule
// don't spam on every 31-min drift).
const RATIO_THRESHOLD = 2.5;
const ABSOLUTE_MIN_MIN = 15;

/**
 * Detect oversized gaps between consecutive buses on the same pattern.
 *
 * For each pid, sort vehicles by pdist and look at consecutive pairs. A gap
 * is the pdist distance between two successive buses — the inverse of a
 * bunch. We need at least 2 vehicles to define one.
 *
 * `expectedHeadwayForPid(pid)` returns scheduled headway in minutes or null
 * if the route isn't indexed; null means we can't evaluate severity so the
 * pair is skipped.
 *
 * Returns gap events sorted worst-first by ratio (observed/expected).
 */
function detectAllGaps(vehicles, expectedHeadwayForPid, patternForPid, now = new Date()) {
  const fresh = vehicles.filter((v) => now - v.tmstmp < STALE_MS);

  const byPid = new Map();
  for (const v of fresh) {
    if (!byPid.has(v.pid)) byPid.set(v.pid, []);
    byPid.get(v.pid).push(v);
  }

  const gaps = [];
  for (const [pid, group] of byPid) {
    if (group.length < 2) continue;
    const expectedMin = expectedHeadwayForPid(pid);
    if (expectedMin == null) continue;

    const sorted = [...group].sort((a, b) => a.pdist - b.pdist);
    const pattern = patternForPid(pid);
    const patternLengthFt = pattern?.lengthFt || 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const gapFt = b.pdist - a.pdist;
      const gapMin = gapFt / TYPICAL_SPEED_FT_PER_MIN;

      // Skip pairs that straddle a terminal zone on either side — the bus
      // just past the start or about to finish isn't in "service territory"
      // for headway purposes, and the bus behind/ahead of it gets a misleading
      // gap measurement.
      if (a.pdist < TERMINAL_PDIST_FT) continue;
      if (patternLengthFt && patternLengthFt - b.pdist < TERMINAL_PDIST_FT) continue;

      const ratio = gapMin / expectedMin;
      if (gapMin < ABSOLUTE_MIN_MIN) continue;
      if (ratio < RATIO_THRESHOLD) continue;

      gaps.push({
        pid,
        route: a.route,
        leading: a,           // downstream bus (farther along the route)
        trailing: b,          // upstream bus (closer to start)
        gapFt,
        gapMin,
        expectedMin,
        ratio,
      });
    }
  }

  gaps.sort((a, b) => b.ratio - a.ratio);
  return gaps;
}

module.exports = { detectAllGaps, RATIO_THRESHOLD, ABSOLUTE_MIN_MIN, TYPICAL_SPEED_FT_PER_MIN };
