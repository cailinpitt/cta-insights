// Held-bus cluster detection. Finds groups of buses on the same pid that
// have stopped advancing along the route while no other bus is moving
// through them — signal for a service-blocking event (police hold, lift
// bridge stuck, accident on the route) where the bus pulse blackout
// detector misses because the buses are still pinging from their stopped
// positions.

const { classifyBusMotion } = require('./motion');

const DEFAULT_HELD_CLUSTER_FT = 1320; // 0.25 mi (~3 city blocks)
const DEFAULT_HELD_MIN_BUSES = 2;
const DEFAULT_HELD_MIN_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MOVING_VETO_FT = 2640;

function detectHeldBusClusters({ route, observations, now, headwayMin, opts = {} }) {
  const clusterFt = opts.clusterFt || DEFAULT_HELD_CLUSTER_FT;
  const minBuses = opts.minBuses || DEFAULT_HELD_MIN_BUSES;
  const minDurationMs = Math.max(
    DEFAULT_HELD_MIN_DURATION_MS,
    headwayMin != null ? 1.5 * headwayMin * 60 * 1000 : DEFAULT_HELD_MIN_DURATION_MS,
  );
  const movingVetoFt = opts.movingVetoFt || DEFAULT_MOVING_VETO_FT;

  if (!observations || observations.length === 0) {
    return { skipped: 'no-input', candidates: [] };
  }

  const motion = classifyBusMotion({ observations, now, opts });

  const byPid = new Map();
  for (const [vid, m] of motion) {
    if (!m.pid) continue;
    let arr = byPid.get(m.pid);
    if (!arr) {
      arr = { stationary: [], moving: [] };
      byPid.set(m.pid, arr);
    }
    if (m.bucket === 'stationary' && (m.tailSpanMs || m.spanMs) >= minDurationMs) {
      arr.stationary.push({ vid, ...m });
    } else if (m.bucket === 'moving') {
      arr.moving.push({ vid, ...m });
    }
  }

  const candidates = [];
  for (const [pid, group] of byPid) {
    if (group.stationary.length < minBuses) continue;
    const stationary = group.stationary.sort((a, b) => a.lastPdist - b.lastPdist);
    let bestStart = 0;
    let bestEnd = 0;
    for (let i = 0; i < stationary.length; i++) {
      let j = i;
      while (
        j + 1 < stationary.length &&
        stationary[j + 1].lastPdist - stationary[i].lastPdist <= clusterFt
      ) {
        j++;
      }
      if (j - i > bestEnd - bestStart) {
        bestStart = i;
        bestEnd = j;
      }
    }
    const cluster = stationary.slice(bestStart, bestEnd + 1);
    if (cluster.length < minBuses) continue;
    const clusterLoFt = cluster[0].lastPdist;
    const clusterHiFt = cluster[cluster.length - 1].lastPdist;
    const clusterMidFt = (clusterLoFt + clusterHiFt) / 2;

    const movingNearCluster = group.moving.filter(
      (m) => Math.abs(m.lastPdist - clusterMidFt) <= movingVetoFt,
    );
    if (movingNearCluster.length > 0) continue;

    const stationaryMs = Math.max(...cluster.map((c) => c.tailSpanMs || c.spanMs));
    candidates.push({
      route,
      pid,
      busCount: cluster.length,
      stationaryMs,
      clusterLoFt,
      clusterHiFt,
      clusterMidFt,
      lat: cluster[0].lastLat,
      lon: cluster[0].lastLon,
      vehicleIds: cluster.map((c) => c.vid),
      headwayMin: headwayMin != null ? headwayMin : null,
      movingElsewhereOnPid: group.moving.length,
    });
  }

  candidates.sort((a, b) => {
    if (b.busCount !== a.busCount) return b.busCount - a.busCount;
    return b.stationaryMs - a.stationaryMs;
  });
  return { skipped: null, candidates };
}

module.exports = {
  detectHeldBusClusters,
  DEFAULT_HELD_CLUSTER_FT,
  DEFAULT_HELD_MIN_BUSES,
  DEFAULT_HELD_MIN_DURATION_MS,
  DEFAULT_MOVING_VETO_FT,
};
