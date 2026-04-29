const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { cumulativeDistances, haversineFt, bearing } = require('../../shared/geo');
const { fitZoom, project } = require('../../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  ROUTE_HALO_STROKE,
  ROUTE_CORE_COLOR,
  ROUTE_CORE_STROKE,
  TWEMOJI_HOUSE_INNER,
  TWEMOJI_FLAG_INNER,
  buildBusMarker,
  buildTerminalMarker,
  buildDirectionArrow,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
} = require('../common');
const { isArticulated } = require('../../bus/fleet');

const BUS_COLOR = 'ff2a6d'; // hot pink/red reads well on dark
const CONTEXT_PAD_FT = 1500; // feet of route context on each side of the bunch
const BUS_MARKER_RADIUS = 34;
const TERMINAL_MARKER_RADIUS = BUS_MARKER_RADIUS;

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
  // which previously produced 90°-off arrows on straight streets. The slice
  // is filtered from pattern.points preserving seq order, and CTA seq runs
  // origin → destination along the service direction, so slice[0]→slice[end]
  // already IS the service direction. Don't second-guess with leadBus.heading
  // — a bus parked at a terminal often faces the opposite way, which would
  // flip the arrow to point east on a westbound route.
  const slicePoints = slice.map((p) => ({ lat: p.lat, lon: p.lon }));
  const leadBus = bunch.vehicles.reduce((a, b) => (b.pdist > a.pdist ? b : a), bunch.vehicles[0]);
  const bearingDeg =
    slicePoints.length >= 2
      ? bearing(slicePoints[0], slicePoints[slicePoints.length - 1])
      : leadBus.heading;

  // CTA orders pattern points by seq along the service direction, so the first
  // point is the route's origin and the last is its destination. We mark the
  // origin with a house and the destination with a checkered flag so viewers
  // can see at a glance which way the buses are heading.
  const originPoint = pattern.points[0];
  const terminalPoint = pattern.points[pattern.points.length - 1];
  const origin = originPoint ? { lat: originPoint.lat, lon: originPoint.lon } : null;
  const terminal = terminalPoint ? { lat: terminalPoint.lat, lon: terminalPoint.lon } : null;

  return { overlays, centerLat, centerLon, zoom, bearingDeg, bbox, origin, terminal };
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
    const { x, y } = project(
      s.lat,
      s.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
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
  // Nudge markers apart so a tight bunch (buses within a few feet on-street) still
  // shows every vehicle instead of one disc covering the others. Push sideways
  // (perpendicular to the route bearing) so buses on a straight road don't look
  // further ahead/behind than they actually are.
  const rawMarkerPixels = vehicles.map((v) =>
    project(v.lat, v.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const markerPixels = separateMarkers(rawMarkerPixels, BUS_MARKER_RADIUS * 2 + 4, {
    axis: perpendicularFromBearing(view.bearingDeg),
  });
  const markerElements = markerPixels.map(({ x, y }, i) =>
    buildBusMarker({
      x,
      y,
      radius: BUS_MARKER_RADIUS,
      color: BUS_COLOR,
      articulated: isArticulated(vehicles[i]?.vid),
    }),
  );
  const arrowElements = [buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)];

  // Origin (house) and destination (flag) markers — render below buses (so a
  // bus sitting at either still reads clearly) but above signals. Each is
  // skipped if its point falls outside the viewport.
  const terminalElements = [];
  for (const [point, glyph] of [
    [view.origin, TWEMOJI_HOUSE_INNER],
    [view.terminal, TWEMOJI_FLAG_INNER],
  ]) {
    if (!point) continue;
    const { x, y } = project(
      point.lat,
      point.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue;
    terminalElements.push(...buildTerminalMarker(x, y, TERMINAL_MARKER_RADIUS, glyph));
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${signalElements.join('\n')}${terminalElements.join('\n')}${markerElements.join('\n')}${arrowElements.join('\n')}</svg>`;
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
