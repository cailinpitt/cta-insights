const { buildLinePolyline, snapToLine } = require('./speedmap');
const { terminalZoneFt: terminalZoneFor } = require('../shared/geo');

// 25 mph cruise + dwell ≈ 2200 ft/min. Used as a ratio against GTFS headway,
// not an absolute ETA.
const TYPICAL_TRAIN_SPEED_FT_PER_MIN = 2200;
const RATIO_THRESHOLD = 2.5;
const ABSOLUTE_MIN_MIN = 10;

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

  // Precomputed so per-gap midpoint lookup is a scan, not re-snapping.
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
    const terminalZoneFt = terminalZoneFor(totalFt);

    const snapped = group
      .map((t) => ({ train: t, trackDist: snapToLine(t.lat, t.lon, points, cumDist) }))
      .sort((a, b) => a.trackDist - b.trackDist);

    // Same trDr → same scheduled-headway destination, so any sample works.
    const sampleDest = group.find((t) => t.destination)?.destination;
    const destStation = sampleDest ? stationsByName(line, sampleDest) : null;
    const expectedMin = expectedHeadwayForLine(line, destStation);
    if (expectedMin == null) continue;

    for (let i = 0; i < snapped.length - 1; i++) {
      const a = snapped[i];
      const b = snapped[i + 1];
      const gapFt = b.trackDist - a.trackDist;
      if (gapFt <= 0) continue;

      if (a.trackDist < terminalZoneFt) continue;
      if (totalFt - b.trackDist < terminalZoneFt) continue;

      const gapMin = gapFt / TYPICAL_TRAIN_SPEED_FT_PER_MIN;
      const ratio = gapMin / expectedMin;
      if (gapMin < ABSOLUTE_MIN_MIN) continue;
      if (ratio < RATIO_THRESHOLD) continue;

      // Midpoint station so "near X" points to the empty stretch, not either train's next stop.
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
        // a is upstream — rider near `leading` (b) just watched it pass and is waiting on `trailing` (a).
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
