const EARTH_RADIUS_FT = 20902231; // feet

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineFt(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_FT * Math.asin(Math.sqrt(h));
}

/**
 * Walk pattern points in seq order and return a parallel array of cumulative
 * distance in feet. The CTA API only populates pdist on stop points, so we can't
 * rely on it for slicing arbitrary windows of the polyline.
 */
function cumulativeDistances(points) {
  const result = new Array(points.length);
  result[0] = 0;
  for (let i = 1; i < points.length; i++) {
    result[i] = result[i - 1] + haversineFt(points[i - 1], points[i]);
  }
  return result;
}

module.exports = { haversineFt, cumulativeDistances };
