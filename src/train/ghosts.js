// Ghost train detection. Mirrors detectBusGhosts — compares observed active
// train count (median per snapshot) against `trip_duration / headway` per
// (line, trDr).

const { MISSING_PCT_THRESHOLD, MISSING_ABS_THRESHOLD, MIN_SNAPSHOTS } = require('../bus/ghosts');

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Detect ghost trains for a set of lines over a time window.
 *
 * Dependencies injected:
 *   - `getObservations(line)` → [{ ts, direction (trDr), vehicle_id, destination }]
 *   - `findStation(line, destinationName)` → { lat, lon, name } | null
 *   - `expectedHeadway(line, destinationStation)` → minutes or null
 *   - `expectedDuration(line, destinationStation)` → minutes or null
 *   - `isLoopLine(line)` → true for lines whose GTFS ships a single
 *     direction_id covering the full round trip (Brown/Orange/Pink/Purple/
 *     Yellow). Optional; defaults to false. Loop lines can't be split by
 *     trDr without halving the expected count — it's simpler to compare the
 *     line-wide observed vehicle count against the line-wide expected.
 */
async function detectTrainGhosts({
  lines,
  getObservations,
  findStation,
  expectedHeadway,
  expectedDuration,
  isLoopLine,
}) {
  const events = [];

  for (const line of lines) {
    const obs = getObservations(line);
    if (obs.length === 0) continue;

    // Loop lines: aggregate across trDrs. GTFS gives us one duration (full
    // Midway→Loop→Midway leg) and one headway for the whole line, so
    // `duration / headway` is the total active train count line-wide — which
    // is what we need to compare against.
    if (isLoopLine && isLoopLine(line)) {
      const headway = expectedHeadway(line, null);
      const duration = expectedDuration(line, null);
      if (headway == null || duration == null || headway <= 0 || duration <= 0) continue;

      const expectedActive = duration / headway;
      if (expectedActive < 2) continue;

      const perSnapshot = new Map();
      for (const o of obs) {
        if (!perSnapshot.has(o.ts)) perSnapshot.set(o.ts, new Set());
        perSnapshot.get(o.ts).add(o.vehicle_id);
      }
      if (perSnapshot.size < MIN_SNAPSHOTS) continue;

      const counts = [...perSnapshot.values()].map((s) => s.size);
      const observedActive = median(counts);
      const missing = expectedActive - observedActive;
      if (missing < MISSING_ABS_THRESHOLD) continue;
      if (missing / expectedActive < MISSING_PCT_THRESHOLD) continue;

      events.push({
        line,
        trDr: null,
        destination: null,
        expectedActive,
        observedActive,
        missing,
        snapshots: perSnapshot.size,
        headway,
        duration,
      });
      continue;
    }

    // Bi-directional lines: group by trDr and use the direction-specific
    // GTFS headway/duration selected by destination.
    const byDir = new Map(); // trDr → observations[]
    for (const o of obs) {
      if (!o.direction) continue;
      if (!byDir.has(o.direction)) byDir.set(o.direction, []);
      byDir.get(o.direction).push(o);
    }

    for (const [trDr, group] of byDir) {
      // Pick any observed destination on this direction as the direction proxy
      // (same trDr → same rail terminus for headway lookup purposes).
      const sampleDest = group.find((o) => o.destination)?.destination;
      const destStation = sampleDest ? findStation(line, sampleDest) : null;
      const headway = expectedHeadway(line, destStation);
      const duration = expectedDuration(line, destStation);
      if (headway == null || duration == null || headway <= 0 || duration <= 0) continue;

      const expectedActive = duration / headway;
      if (expectedActive < 2) continue;

      const perSnapshot = new Map();
      for (const o of group) {
        if (!perSnapshot.has(o.ts)) perSnapshot.set(o.ts, new Set());
        perSnapshot.get(o.ts).add(o.vehicle_id);
      }
      if (perSnapshot.size < MIN_SNAPSHOTS) continue;

      const counts = [...perSnapshot.values()].map((s) => s.size);
      const observedActive = median(counts);
      const missing = expectedActive - observedActive;
      if (missing < MISSING_ABS_THRESHOLD) continue;
      if (missing / expectedActive < MISSING_PCT_THRESHOLD) continue;

      events.push({
        line,
        trDr,
        destination: sampleDest,
        expectedActive,
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

module.exports = { detectTrainGhosts };
