// Google Encoded Polyline Algorithm — used by Mapbox Static Images for path overlays.
// https://developers.google.com/maps/documentation/utilities/polylinealgorithmexample

function encodeSigned(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

function encode(points, precision = 5) {
  const factor = Math.pow(10, precision);
  let lastLat = 0;
  let lastLon = 0;
  let out = '';
  for (const [lat, lon] of points) {
    const ilat = Math.round(lat * factor);
    const ilon = Math.round(lon * factor);
    out += encodeSigned(ilat - lastLat);
    out += encodeSigned(ilon - lastLon);
    lastLat = ilat;
    lastLon = ilon;
  }
  return out;
}

module.exports = { encode };
