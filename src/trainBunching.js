const { haversineFt } = require('./geo');

const TRAIN_BUNCHING_FT = 2000; // ~0.38 mi, tighter than normal rush-hour headway
const MIN_DISTANCE_FT = 200;    // ignore pairs closer than this — likely same station or API glitch

/**
 * Detect the tightest bunched pair of trains on the same line heading the same
 * direction (same `trDr`).
 *
 * Unlike buses, trains don't report a pdist-style distance along the route, so we
 * use straight-line haversine distance. This works because L lines mostly don't
 * branch — the only real branching line is Green, and its branches are far enough
 * apart (Ashland Ave vs. Cottage Grove) that cross-branch false positives aren't
 * realistic for the typical threshold.
 *
 * Returns null if no bunch is detected.
 */
function detectTrainBunching(trains) {
  const groups = new Map();
  for (const t of trains) {
    if (!t.trDr) continue;
    const key = `${t.line}_${t.trDr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  let best = null;
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const dist = haversineFt(group[i], group[j]);
        if (dist < MIN_DISTANCE_FT || dist > TRAIN_BUNCHING_FT) continue;
        if (!best || dist < best.distanceFt) {
          const [line, trDr] = key.split('_');
          best = {
            line,
            trDr,
            trains: [group[i], group[j]],
            distanceFt: dist,
          };
        }
      }
    }
  }

  return best;
}

module.exports = { detectTrainBunching, TRAIN_BUNCHING_FT, MIN_DISTANCE_FT };
