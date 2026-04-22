const trainStations = require('./data/trainStations.json');

// Destinations Train Tracker emits that don't match any station name verbatim.
// Mapped values must match `name` in trainStations.json exactly (case sensitive).
// `null` entries mean "deliberately unresolvable" — the caller should treat them
// as unknown and skip the direction (e.g. "Loop" has no single terminus).
const DESTINATION_ALIASES = {
  '95th/dan ryan': '95th/Dan Ryan',
  '95th': '95th/Dan Ryan',
  '54th/cermak': '54th/Cermak',
  'loop': null,
  'see train': null,
};

const _loggedMisses = new Set();

// Match on the train's own line so we don't collide on repeated station names
// like "Halsted" (Orange vs Blue). Tiered:
//   1) alias table (deliberate hand-curation for known non-verbatim strings)
//   2) exact name match (case-insensitive)
//   3) exact base-name match before parenthetical (e.g. "Harlem (Blue - ...)")
// Loose `startsWith`/`includes` tiers were removed — they cross-matched
// station names on prefix collisions. Unresolvable destinations log once so
// new aliases surface in the cron log.
function findStationByDestination(line, destination, stations = trainStations) {
  if (!destination) return null;
  const norm = destination.toLowerCase().trim();

  if (norm in DESTINATION_ALIASES) {
    const target = DESTINATION_ALIASES[norm];
    if (target == null) return null;
    const hit = stations.find((s) => s.name === target && s.lines?.includes(line));
    if (hit) return hit;
  }

  const candidates = stations.filter((s) => s.lines?.includes(line));
  for (const s of candidates) {
    if (s.name.toLowerCase() === norm) return s;
  }
  for (const s of candidates) {
    const baseName = s.name.toLowerCase().split(' (')[0].trim();
    if (baseName === norm) return s;
  }

  const missKey = `${line}|${norm}`;
  if (!_loggedMisses.has(missKey)) {
    _loggedMisses.add(missKey);
    console.warn(`findStation: unresolved destination '${destination}' on line '${line}' — consider adding to DESTINATION_ALIASES`);
  }
  return null;
}

module.exports = { findStationByDestination, DESTINATION_ALIASES };
