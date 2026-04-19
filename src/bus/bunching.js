const BUNCHING_THRESHOLD_FT = 1000; // ~0.19 mi, ~3 Chicago city blocks
const STALE_MS = 3 * 60 * 1000; // ignore vehicles that haven't reported in 3 min
const TERMINAL_PDIST_FT = 500; // bunches where all buses are within this of the start are layovers, not bunching

/**
 * Detect all bunching events across all vehicles, ranked best-first.
 *
 * Strategy: group vehicles by pid (pattern = route + direction), sort by
 * pdist (distance along route in feet), find consecutive pairs within the
 * threshold, and extend each cluster as long as neighbors are also close.
 * Ranks clusters by size desc, then max-gap asc (larger/tighter = more severe).
 *
 * Returns an array of bunch events (may be empty). The entry point picks the
 * first one whose pid isn't on cooldown — so a persistent bunch on route A
 * doesn't stop us from posting a fresh event on route B in the same run.
 */
function detectAllBunching(vehicles, now = new Date()) {
  const fresh = vehicles.filter((v) => now - v.tmstmp < STALE_MS);

  const byPid = new Map();
  for (const v of fresh) {
    if (!byPid.has(v.pid)) byPid.set(v.pid, []);
    byPid.get(v.pid).push(v);
  }

  const bunches = [];
  for (const [pid, group] of byPid) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.pdist - b.pdist);

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
      // Skip start-terminal layovers: any bus within TERMINAL_PDIST_FT of pdist 0
      // means the cluster is the terminal lineup shaking out, not real bunching.
      if (cluster[0].pdist < TERMINAL_PDIST_FT) {
        i = j + 1;
        continue;
      }
      bunches.push({
        pid,
        route: cluster[0].route,
        vehicles: cluster,
        maxGapFt: maxGap,
        spanFt: cluster[cluster.length - 1].pdist - cluster[0].pdist,
      });
      i = j + 1;
    }
  }

  // Sort best-first: more buses is more severe; tie-break on tighter max gap.
  bunches.sort((a, b) => {
    if (a.vehicles.length !== b.vehicles.length) return b.vehicles.length - a.vehicles.length;
    return a.maxGapFt - b.maxGapFt;
  });

  return bunches;
}

// Back-compat wrapper for any callers that want just the single best bunch.
function detectBunching(vehicles, now = new Date()) {
  const all = detectAllBunching(vehicles, now);
  return all[0] || null;
}

module.exports = { detectAllBunching, detectBunching, BUNCHING_THRESHOLD_FT };
