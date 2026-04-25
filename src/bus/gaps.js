const STALE_MS = 3 * 60 * 1000;
// 10 mph ≈ 880 ft/min once stops + signals are factored in. Crude, but only
// used as a ratio against GTFS-scheduled headway — not an absolute ETA.
const TYPICAL_SPEED_FT_PER_MIN = 880;
const { terminalZoneFt } = require('../shared/geo');
// Absolute floor protects low-frequency routes (30-min schedule) from
// spamming on every 31-min drift.
const RATIO_THRESHOLD = 2.5;
const ABSOLUTE_MIN_MIN = 15;

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
    if (!patternLengthFt) continue;
    const zoneFt = terminalZoneFt(patternLengthFt);

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const gapFt = b.pdist - a.pdist;
      const gapMin = gapFt / TYPICAL_SPEED_FT_PER_MIN;

      // Buses inside the terminal zone aren't in "service territory" yet —
      // their headway measurement against the next bus is misleading.
      if (a.pdist < zoneFt) continue;
      if (patternLengthFt - b.pdist < zoneFt) continue;

      const ratio = gapMin / expectedMin;
      if (gapMin < ABSOLUTE_MIN_MIN) continue;
      if (ratio < RATIO_THRESHOLD) continue;

      gaps.push({
        pid,
        route: a.route,
        // a is upstream (sorted by pdist asc) — a rider near `leading` (b) just
        // watched it pass and is waiting on `trailing` (a).
        leading: b,
        trailing: a,
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

