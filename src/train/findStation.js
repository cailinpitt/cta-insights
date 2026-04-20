const trainStations = require('./data/trainStations.json');

// Destination strings from Train Tracker don't always match trainStations.json
// verbatim (e.g. "95th/Dan Ryan" vs "95th"). Match on the train's own line so
// we don't collide on repeated station names like "Halsted" (Orange vs Blue).
function findStationByDestination(line, destination, stations = trainStations) {
  if (!destination) return null;
  const norm = destination.toLowerCase();
  const candidates = stations.filter((s) => s.lines?.includes(line));
  for (const s of candidates) {
    if (s.name.toLowerCase() === norm) return s;
  }
  for (const s of candidates) {
    const baseName = s.name.toLowerCase().split(' (')[0];
    if (baseName === norm || baseName.startsWith(norm) || norm.startsWith(baseName)) return s;
  }
  for (const s of candidates) {
    if (s.name.toLowerCase().includes(norm)) return s;
  }
  return null;
}

module.exports = { findStationByDestination };
