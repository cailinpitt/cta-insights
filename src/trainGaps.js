const { buildLinePolyline, snapToLine } = require('./trainSpeedmap');

// Trains cruise faster than buses — typical average between stations on the
// rapid-transit lines is ~25 mph with dwell time mixed in ≈ 2200 ft/min. Only
// used to convert an along-track distance to a rough time gap for ratio
// filtering; refined at post time if we add prediction support.
const TYPICAL_TRAIN_SPEED_FT_PER_MIN = 2200;
// Scale terminal zone with line length, capped — matches the train bunching
// detector so we don't flag queues at start/end terminals as gaps.
const TERMINAL_ZONE_CAP_FT = 1500;
const RATIO_THRESHOLD = 2.5;
const ABSOLUTE_MIN_MIN = 10;

/**
 * Detect oversized gaps between consecutive trains on the same line + trDr.
 *
 * Mirrors `detectAllGaps` for buses: snap each train onto the line polyline,
 * sort by along-track distance, measure consecutive gaps. A gap qualifies
 * when its time estimate is both ≥ ABSOLUTE_MIN_MIN and ≥ RATIO_THRESHOLD ×
 * scheduled headway.
 *
 * `expectedHeadwayForLine(line, destinationStation)` returns scheduled minutes
 * or null. `destinationStation` is a {lat, lon} used to pick direction.
 *
 * Returns gap events sorted worst-first by ratio.
 */
function detectAllTrainGaps(trains, trainLines, stations, stationsByName, expectedHeadwayForLine, now = Date.now()) {
  const groups = new Map();
  for (const t of trains) {
    if (!t.trDr) continue;
    const key = `${t.line}_${t.trDr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const lineCache = new Map();
  function getLine(line) {
    if (!lineCache.has(line)) lineCache.set(line, buildLinePolyline(trainLines, line));
    return lineCache.get(line);
  }

  // Precompute stations' along-track distance per line so midpoint-station
  // lookup is a quick scan instead of re-snapping on every gap.
  const stationTrackCache = new Map();
  function getStationsOnLine(line) {
    if (stationTrackCache.has(line)) return stationTrackCache.get(line);
    const { points, cumDist } = getLine(line);
    const onLine = (stations || [])
      .filter((s) => s.lines?.includes(line))
      .map((s) => ({ station: s, trackDist: snapToLine(s.lat, s.lon, points, cumDist) }));
    stationTrackCache.set(line, onLine);
    return onLine;
  }

  const gaps = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const [line, trDr] = key.split('_');
    const { points, cumDist } = getLine(line);
    if (points.length < 2) continue;
    const totalFt = cumDist[cumDist.length - 1];
    const terminalZoneFt = Math.min(TERMINAL_ZONE_CAP_FT, totalFt * 0.1);

    const snapped = group
      .map((t) => ({ train: t, trackDist: snapToLine(t.lat, t.lon, points, cumDist) }))
      .sort((a, b) => a.trackDist - b.trackDist);

    // Use any train on the group as the destination sample — same trDr means
    // same destination for the purposes of picking a scheduled headway.
    const sampleDest = group.find((t) => t.destination)?.destination;
    const destStation = sampleDest ? stationsByName(line, sampleDest) : null;
    const expectedMin = expectedHeadwayForLine(line, destStation);
    if (expectedMin == null) continue;

    for (let i = 0; i < snapped.length - 1; i++) {
      const a = snapped[i];
      const b = snapped[i + 1];
      const gapFt = b.trackDist - a.trackDist;
      if (gapFt <= 0) continue;

      // Skip pairs that touch a terminal zone — same reasoning as bus gaps.
      if (a.trackDist < terminalZoneFt) continue;
      if (totalFt - b.trackDist < terminalZoneFt) continue;

      const gapMin = gapFt / TYPICAL_TRAIN_SPEED_FT_PER_MIN;
      const ratio = gapMin / expectedMin;
      if (gapMin < ABSOLUTE_MIN_MIN) continue;
      if (ratio < RATIO_THRESHOLD) continue;

      // Station nearest the midpoint — used in post copy so "near X" points to
      // the empty stretch rather than one of the trains' next stations.
      const midTrack = (a.trackDist + b.trackDist) / 2;
      const onLine = getStationsOnLine(line);
      let nearStation = null;
      let bestDelta = Infinity;
      for (const { station, trackDist } of onLine) {
        const delta = Math.abs(trackDist - midTrack);
        if (delta < bestDelta) { bestDelta = delta; nearStation = station; }
      }

      gaps.push({
        line,
        trDr,
        // a is upstream (behind), b is downstream (ahead). A rider standing
        // at a stop just past `leading` is waiting for `trailing`.
        leading: b.train,
        trailing: a.train,
        leadingTrackDist: b.trackDist,
        trailingTrackDist: a.trackDist,
        nearStation,
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

module.exports = {
  detectAllTrainGaps,
  RATIO_THRESHOLD,
  ABSOLUTE_MIN_MIN,
  TYPICAL_TRAIN_SPEED_FT_PER_MIN,
};
