const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { cumulativeDistances, haversineFt, bearing } = require('../../shared/geo');
const { fitZoom, project } = require('../../shared/projection');
const {
  STYLE, WIDTH, HEIGHT,
  ROUTE_HALO_COLOR, ROUTE_HALO_STROKE, ROUTE_CORE_COLOR, ROUTE_CORE_STROKE,
  TWEMOJI_BUS_INNER,
  buildDirectionArrow, requireMapboxToken, fetchMapboxStatic,
} = require('../common');

// Red highlight for the segment *between* the two bounding buses — that's the
// stretch of route where a rider would be waiting.
const GAP_SEGMENT_COLOR = 'ff2a00';
const GAP_SEGMENT_STROKE = 10;
const BUS_COLOR = 'ff2a6d';
const BUS_MARKER_RADIUS = 34;
const CONTEXT_PAD_FT = 1500;

// Walk the pattern in seq order, building cumulative distance, then return
// the ordered sub-polyline between the two buses' nearest-vertex positions.
// Same strategy as slicePatternAroundBunch — pattern.pdist can't be trusted
// for waypoints so we match by haversine distance.
function sliceBetweenVehicles(pattern, a, b) {
  const cum = cumulativeDistances(pattern.points);
  function nearestCum(v) {
    let bestIdx = 0;
    let bestDist = haversineFt(v, pattern.points[0]);
    for (let i = 1; i < pattern.points.length; i++) {
      const d = haversineFt(v, pattern.points[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return { idx: bestIdx, cum: cum[bestIdx] };
  }
  const A = nearestCum(a);
  const B = nearestCum(b);
  const lo = Math.min(A.cum, B.cum);
  const hi = Math.max(A.cum, B.cum);
  const inner = pattern.points.filter((_, i) => cum[i] >= lo && cum[i] <= hi);
  const padLo = lo - CONTEXT_PAD_FT;
  const padHi = hi + CONTEXT_PAD_FT;
  const framing = pattern.points.filter((_, i) => cum[i] >= padLo && cum[i] <= padHi);
  return { inner, framing };
}

function computeGapView(gap, pattern) {
  const { inner, framing } = sliceBetweenVehicles(pattern, gap.leading, gap.trailing);

  const fullPoly = encode(pattern.points.map((p) => [p.lat, p.lon]));
  const gapPoly = encode(inner.map((p) => [p.lat, p.lon]));
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encodeURIComponent(fullPoly)})`,
    `path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encodeURIComponent(fullPoly)})`,
    `path-${GAP_SEGMENT_STROKE}+${GAP_SEGMENT_COLOR}(${encodeURIComponent(gapPoly)})`,
  ];

  const framePts = framing.length > 0 ? framing : inner;
  const vehicles = [gap.leading, gap.trailing];
  const allLats = [...framePts.map((p) => p.lat), ...vehicles.map((v) => v.lat)];
  const allLons = [...framePts.map((p) => p.lon), ...vehicles.map((v) => v.lon)];
  const bbox = {
    minLat: Math.min(...allLats),
    maxLat: Math.max(...allLats),
    minLon: Math.min(...allLons),
    maxLon: Math.max(...allLons),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 60);
  const zoom = Math.max(10, Math.min(17, Math.floor(rawZoom)));

  // Direction arrow: use the framing slice endpoints, smoothed against the
  // leading bus's reported heading (same fallback logic as bunching).
  let bearingDeg = gap.leading.heading;
  if (framePts.length >= 2) {
    const fwd = bearing(framePts[0], framePts[framePts.length - 1]);
    const rev = (fwd + 180) % 360;
    const diffFwd = Math.abs(((gap.leading.heading - fwd + 540) % 360) - 180);
    const diffRev = Math.abs(((gap.leading.heading - rev + 540) % 360) - 180);
    bearingDeg = diffFwd <= diffRev ? fwd : rev;
  }

  return { overlays, centerLat, centerLon, zoom, bearingDeg };
}

async function fetchGapBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

async function renderGapMap(gap, pattern) {
  const view = computeGapView(gap, pattern);
  const baseMap = await fetchGapBaseMap(view);
  const vehicles = [gap.leading, gap.trailing];
  const markerElements = vehicles.map((v) => {
    const { x, y } = project(v.lat, v.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT);
    const iconSize = BUS_MARKER_RADIUS * 1.6;
    const iconX = x - iconSize / 2;
    const iconY = y - iconSize / 2;
    return [
      `<circle cx="${x}" cy="${y}" r="${BUS_MARKER_RADIUS}" fill="#${BUS_COLOR}" stroke="#fff" stroke-width="4"/>`,
      `<svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 36 36">${TWEMOJI_BUS_INNER}</svg>`,
    ].join('');
  });
  const arrowElements = [buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${markerElements.join('\n')}${arrowElements.join('\n')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { renderGapMap };
