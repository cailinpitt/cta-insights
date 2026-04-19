const sharp = require('sharp');
const { encode } = require('../polyline');
const { cumulativeDistances, haversineFt, bearing } = require('../geo');
const { fitZoom, project } = require('../projection');
const {
  STYLE, WIDTH, HEIGHT,
  ROUTE_HALO_COLOR, ROUTE_HALO_STROKE, ROUTE_CORE_COLOR, ROUTE_CORE_STROKE,
  TWEMOJI_BUS_INNER,
  buildDirectionArrow, requireMapboxToken, fetchMapboxStatic,
} = require('./common');

const BUS_COLOR = 'ff2a6d';         // hot pink/red reads well on dark
const CONTEXT_PAD_FT = 1500;        // feet of route context on each side of the bunch
const BUS_MARKER_RADIUS = 34;

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

/**
 * Compute the static framing for a bunching render: bbox, center, zoom,
 * polyline overlays, and the route-direction arrow. Accepts an optional
 * `extraVehicles` list so video captures can pre-expand the bbox to cover
 * all frames, keeping the viewport stable as buses move.
 */
function computeBunchingView(bunch, pattern, extraVehicles = []) {
  const slice = slicePatternAroundBunch(pattern, bunch);
  const polyline = encode(pattern.points.map((p) => [p.lat, p.lon]));
  const encoded = encodeURIComponent(polyline);
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`,
    `path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`,
  ];

  const framingVehicles = [...bunch.vehicles, ...extraVehicles];
  const allLats = [...slice.map((p) => p.lat), ...framingVehicles.map((v) => v.lat)];
  const allLons = [...slice.map((p) => p.lon), ...framingVehicles.map((v) => v.lon)];
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

  // Route-wide direction bearing from the slice endpoints (smoothed over ~3000
  // ft). This avoids a short orthogonal waypoint jog dominating the arrow,
  // which previously produced 90°-off arrows on straight streets.
  const slicePoints = slice.map((p) => ({ lat: p.lat, lon: p.lon }));
  const leadBus = bunch.vehicles.reduce((a, b) => (b.pdist > a.pdist ? b : a), bunch.vehicles[0]);
  let bearingDeg = leadBus.heading;
  if (slicePoints.length >= 2) {
    const fwd = bearing(slicePoints[0], slicePoints[slicePoints.length - 1]);
    const rev = (fwd + 180) % 360;
    const diffFwd = Math.abs(((leadBus.heading - fwd + 540) % 360) - 180);
    const diffRev = Math.abs(((leadBus.heading - rev + 540) % 360) - 180);
    bearingDeg = diffFwd <= diffRev ? fwd : rev;
  }

  return { overlays, centerLat, centerLon, zoom, bearingDeg, bbox };
}

async function fetchBunchingBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

// Composite bus markers, traffic-signal dots, and the direction arrow onto a
// pre-fetched base map. The base map, signals, and arrow are static across a
// video; only marker positions vary.
async function renderBunchingFrame(view, baseMap, vehicles, signals = []) {
  // Signals render below buses — small traffic-light glyphs that read clearly
  // without competing with the primary markers. Drawn inline (not via Unicode)
  // so librsvg renders the same shape on every host. Housings rotate to sit
  // perpendicular to the route: horizontal (E-W) streets get vertical signals,
  // N-S streets get horizontal ones — matching how real lights face drivers.
  const SIGNAL_LONG = 36;
  const SIGNAL_SHORT = 16;
  const signalElements = signals.map((s) => {
    const { x, y } = project(s.lat, s.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT);
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) return '';
    const vertical = s.orientation === 'vertical';
    const w = vertical ? SIGNAL_SHORT : SIGNAL_LONG;
    const h = vertical ? SIGNAL_LONG : SIGNAL_SHORT;
    const left = x - w / 2;
    const top = y - h / 2;
    const redOff = 7;
    const yellowOff = 18;
    const greenOff = 29;
    return [
      `<rect x="${left}" y="${top}" width="${w}" height="${h}" rx="4" ry="4" fill="#1c1c1c" stroke="#fff" stroke-width="1.5"/>`,
      vertical
        ? `<circle cx="${x}" cy="${top + redOff}" r="4" fill="#e53935"/>`
        : `<circle cx="${left + redOff}" cy="${y}" r="4" fill="#e53935"/>`,
      vertical
        ? `<circle cx="${x}" cy="${top + yellowOff}" r="4" fill="#fdd835"/>`
        : `<circle cx="${left + yellowOff}" cy="${y}" r="4" fill="#fdd835"/>`,
      vertical
        ? `<circle cx="${x}" cy="${top + greenOff}" r="4" fill="#43a047"/>`
        : `<circle cx="${left + greenOff}" cy="${y}" r="4" fill="#43a047"/>`,
    ].join('');
  });
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${signalElements.join('\n')}${markerElements.join('\n')}${arrowElements.join('\n')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function renderBunchingMap(bunch, pattern, signals = []) {
  const view = computeBunchingView(bunch, pattern);
  const baseMap = await fetchBunchingBaseMap(view);
  return renderBunchingFrame(view, baseMap, bunch.vehicles, signals);
}

module.exports = {
  renderBunchingMap,
  computeBunchingView,
  fetchBunchingBaseMap,
  renderBunchingFrame,
};
