const axios = require('axios');
const sharp = require('sharp');
const { encode } = require('./polyline');
const { cumulativeDistances, haversineFt } = require('./geo');

const STYLE = 'mapbox/dark-v11';
const WIDTH = 1200;
const HEIGHT = 1200;

// Two-tone route line: dark halo + bright core makes the route pop against the basemap.
const ROUTE_HALO_COLOR = '000';
const ROUTE_HALO_STROKE = 9;
const ROUTE_CORE_COLOR = '00d8ff';
const ROUTE_CORE_STROKE = 4;

const BUS_COLOR = 'ff2a6d';         // hot pink/red reads well on dark
const CONTEXT_PAD_FT = 3000;        // feet of route context on each side of the bunch

/**
 * Slice pattern points to a window around the bunched buses' geographic position.
 *
 * We walk the polyline in seq order building a cumulative haversine distance,
 * then find the cumulative-distance positions nearest to each bus (matching by
 * straight-line proximity) and slice with CONTEXT_PAD_FT buffer around that range.
 *
 * We can't trust point.pdist for this — the CTA API only populates pdist on stops,
 * leaving waypoints at 0, which would make a naive pdist filter pull in every
 * waypoint scattered across the whole route.
 */
function slicePatternAroundBunch(pattern, bunch) {
  const cum = cumulativeDistances(pattern.points);

  // For each vehicle, find the pattern point geographically closest to it,
  // and take that point's cumulative distance as the vehicle's position along
  // the line. Then slice the polyline to [min - pad, max + pad].
  const vehiclePositions = bunch.vehicles.map((v) => {
    let bestIdx = 0;
    let bestDist = haversineFt(v, pattern.points[0]);
    for (let i = 1; i < pattern.points.length; i++) {
      const d = haversineFt(v, pattern.points[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return cum[bestIdx];
  });

  const minCum = Math.min(...vehiclePositions) - CONTEXT_PAD_FT;
  const maxCum = Math.max(...vehiclePositions) + CONTEXT_PAD_FT;
  return pattern.points.filter((_, i) => cum[i] >= minCum && cum[i] <= maxCum);
}

async function renderBunchingMap(bunch, pattern) {
  const slice = slicePatternAroundBunch(pattern, bunch);
  const polyline = encode(slice.map((p) => [p.lat, p.lon]));

  const overlays = [];
  // Draw halo first, then core, so core renders on top. Pins render on top of both.
  const encoded = encodeURIComponent(polyline);
  overlays.push(`path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`);
  overlays.push(`path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`);
  // Use the Maki "bus" icon for a clear transit visual on each pin.
  for (const v of bunch.vehicles) {
    overlays.push(`pin-m-bus+${BUS_COLOR}(${v.lon.toFixed(6)},${v.lat.toFixed(6)})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;

  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });

  // Bluesky image limit is 1MB; convert to JPEG to stay under it.
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderBunchingMap };
