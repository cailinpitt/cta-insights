const BUNCHING_THRESHOLD_FT = 1000; // ~0.19 mi, ~3 Chicago city blocks
const STALE_MS = 3 * 60 * 1000; // ignore vehicles that haven't reported in 3 min
const TERMINAL_PDIST_FT = 500; // bunches where all buses are within this of the start are layovers, not bunching

/**
 * Detect the worst bunching event across all vehicles.
 *
 * Strategy: group vehicles by pid (pattern = route + direction), sort by
 * pdist (distance along route in feet), find consecutive pairs within the
 * threshold, and extend the cluster as long as neighbors are also close.
 * Pick the cluster with the smallest max-gap.
 *
 * Returns null if no bunching is detected.
 */
function detectBunching(vehicles, now = new Date()) {
  const fresh = vehicles.filter((v) => now - v.tmstmp < STALE_MS);

  const byPid = new Map();
  for (const v of fresh) {
    if (!byPid.has(v.pid)) byPid.set(v.pid, []);
    byPid.get(v.pid).push(v);
  }

  let best = null;
  for (const [pid, group] of byPid) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.pdist - b.pdist);

    // Find all clusters: consecutive runs where each gap <= threshold.
    let i = 0;
    while (i < sorted.length - 1) {
      if (sorted[i + 1].pdist - sorted[i].pdist > BUNCHING_THRESHOLD_FT) {
        i++;
        continue;
      }
      let j = i + 1;
      let maxGap = sorted[j].pdist - sorted[i].pdist;
      while (j + 1 < sorted.length && sorted[j + 1].pdist - sorted[j].pdist <= BUNCHING_THRESHOLD_FT) {
        maxGap = Math.max(maxGap, sorted[j + 1].pdist - sorted[j].pdist);
        j++;
      }
      const cluster = sorted.slice(i, j + 1);
      // Skip terminal layovers: all buses stacked at the start of the pattern.
      if (cluster[cluster.length - 1].pdist < TERMINAL_PDIST_FT) {
        i = j + 1;
        continue;
      }
      // Prefer larger clusters, then tighter gaps
      if (!best || cluster.length > best.vehicles.length ||
          (cluster.length === best.vehicles.length && maxGap < best.maxGapFt)) {
        best = {
          pid,
          route: cluster[0].route,
          vehicles: cluster,
          maxGapFt: maxGap,
          spanFt: cluster[cluster.length - 1].pdist - cluster[0].pdist,
        };
      }
      i = j + 1;
    }
  }

  return best;
}

module.exports = { detectBunching, BUNCHING_THRESHOLD_FT };
