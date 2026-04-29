// CTA pattern points are tagged 'S' (stop) or 'W' (waypoint); only stops
// have stopName populated. Strip waypoints so callers don't have to.
function getPatternStops(pattern) {
  return pattern.points
    .filter((p) => p.type === 'S' && p.stopName)
    .map((p) => ({ lat: p.lat, lon: p.lon, stopName: p.stopName, stopId: p.stopId }));
}

module.exports = { getPatternStops };
