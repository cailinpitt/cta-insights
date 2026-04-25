const trainStations = require('./data/trainStations.json');

// Aliases for non-verbatim destination strings. `null` means "deliberately
// unresolvable" — caller skips (e.g. "Loop" has no single terminus).
const DESTINATION_ALIASES = {
  '95th/dan ryan': '95th/Dan Ryan',
  '95th': '95th/Dan Ryan',
  '54th/cermak': '54th/Cermak',
  'loop': null,
  'see train': null,
};

const _loggedMisses = new Set();

// Line-scoped match so "Halsted" (Orange vs Blue) doesn't collide. Tiered:
// alias table → exact name → exact base-name (strip parenthetical). Loose
// startsWith/includes tiers caused cross-matches on prefix collisions.
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
