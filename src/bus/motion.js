// Per-bus motion classification, mirrors src/train/motion.js but tuned for
// bus characteristics: pdist is the canonical along-pattern coordinate (no
// snap needed), stationary spans must be longer than train equivalents
// because buses legitimately dwell 1-2 min at stops + lights, and we group
// by (route, pid) since a single route can have multiple patterns running
// simultaneously.

const DEFAULT_STATIONARY_FT = 300;
const DEFAULT_STATIONARY_MIN_OBS = 3;
const DEFAULT_STATIONARY_MIN_SPAN_MS = 8 * 60 * 1000;
// Buses cruising at normal speed cover ~600-800 ft/min (cycle of running +
// signals/stops). A 20-min tail of normal service is 12000+ ft. Set the
// moving threshold to a noisy floor (8000 ft over the tail = ~400 ft/min
// average, ~5 mph) so buses barely creeping in a held cluster (50-300 ft/min)
// stay in "unknown" — they're affected by the same disruption and shouldn't
// veto the cluster.
const DEFAULT_MOVING_MIN_FT = 8000;
const DEFAULT_MOVING_MIN_OBS = 2;
const DEFAULT_TAIL_OBS = 3;

function classifyBusMotion({ observations, now: _now, opts = {} }) {
  const stationaryFt = opts.stationaryFt || DEFAULT_STATIONARY_FT;
  const stationaryMinObs = opts.stationaryMinObs || DEFAULT_STATIONARY_MIN_OBS;
  const stationaryMinSpanMs = opts.stationaryMinSpanMs || DEFAULT_STATIONARY_MIN_SPAN_MS;
  const movingMinFt = opts.movingMinFt || DEFAULT_MOVING_MIN_FT;
  const movingMinObs = opts.movingMinObs || DEFAULT_MOVING_MIN_OBS;

  const result = new Map();
  if (!observations || observations.length === 0) return result;

  const byVid = new Map();
  for (const o of observations) {
    const vid = o.vehicle_id || o.vid;
    if (!vid || o.pdist == null) continue;
    let arr = byVid.get(vid);
    if (!arr) {
      arr = [];
      byVid.set(vid, arr);
    }
    arr.push({
      ts: o.ts,
      pdist: o.pdist,
      pid: o.pid != null ? o.pid : o.direction || null,
      lat: o.lat,
      lon: o.lon,
    });
  }

  for (const [vid, allObs] of byVid) {
    allObs.sort((a, b) => a.ts - b.ts);
    // A bus that switched pids mid-window has incomparable pdist values
    // across the switch (each pattern has its own zero-point). Restrict
    // motion analysis to the most-recent-pid run only — the older pid's
    // obs belong to a previous trip and would garble the displacement
    // calculation.
    const currentPid = allObs[allObs.length - 1].pid;
    const obs = allObs.filter((o) => o.pid === currentPid);
    let minPd = Infinity;
    let maxPd = -Infinity;
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const o of obs) {
      if (o.pdist < minPd) minPd = o.pdist;
      if (o.pdist > maxPd) maxPd = o.pdist;
      if (o.ts < minTs) minTs = o.ts;
      if (o.ts > maxTs) maxTs = o.ts;
    }
    const displacementFt = maxPd - minPd;
    const obsCount = obs.length;
    const spanMs = maxTs - minTs;
    const dominantPid = currentPid;

    // Tail-based stationary detection: a bus that drove in and then stopped
    // looks "moving" by full-window displacement until the lookback rolls
    // forward. Examining only the most recent DEFAULT_TAIL_OBS obs catches
    // the stuck state much sooner — within the time it takes the bus to be
    // observed N times stationary, not the full lookback. tail size is
    // independent of stationaryMinObs so callers can require more total
    // evidence without delaying detection.
    const tailSize = opts.tailObs || DEFAULT_TAIL_OBS;
    let tailDisplacementFt = displacementFt;
    let tailSpanMs = spanMs;
    if (obs.length >= tailSize) {
      const tail = obs.slice(-tailSize);
      let tailMin = Infinity;
      let tailMax = -Infinity;
      for (const o of tail) {
        if (o.pdist < tailMin) tailMin = o.pdist;
        if (o.pdist > tailMax) tailMax = o.pdist;
      }
      tailDisplacementFt = tailMax - tailMin;
      tailSpanMs = tail[tail.length - 1].ts - tail[0].ts;
    }

    let bucket = 'unknown';
    if (
      tailDisplacementFt <= stationaryFt &&
      obsCount >= stationaryMinObs &&
      tailSpanMs >= stationaryMinSpanMs
    ) {
      bucket = 'stationary';
    } else if (tailDisplacementFt >= movingMinFt && obsCount >= movingMinObs) {
      // Use tail displacement for "moving" too — a bus that drove in and
      // then stopped should NOT be classified as still moving just because
      // its full-window displacement is large. Otherwise the held-cluster
      // moving-veto fires spuriously when multiple held buses share a pid
      // (each one has high full-window displacement from start of route).
      bucket = 'moving';
    }

    const last = obs[obs.length - 1];
    result.set(vid, {
      bucket,
      displacementFt,
      obsCount,
      spanMs,
      tailDisplacementFt,
      tailSpanMs,
      pid: dominantPid,
      lastPdist: last.pdist,
      lastLat: last.lat,
      lastLon: last.lon,
      firstTs: minTs,
      lastTs: maxTs,
    });
  }

  return result;
}

function summarizeBusMotion(motionMap) {
  let moving = 0;
  let stationary = 0;
  let unknown = 0;
  for (const m of motionMap.values()) {
    if (m.bucket === 'moving') moving++;
    else if (m.bucket === 'stationary') stationary++;
    else unknown++;
  }
  return { moving, stationary, unknown, total: motionMap.size };
}

module.exports = {
  classifyBusMotion,
  summarizeBusMotion,
  DEFAULT_STATIONARY_FT,
  DEFAULT_STATIONARY_MIN_OBS,
  DEFAULT_STATIONARY_MIN_SPAN_MS,
  DEFAULT_MOVING_MIN_FT,
};
