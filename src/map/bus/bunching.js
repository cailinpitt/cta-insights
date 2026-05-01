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
  buildStopMarker,
  buildStopDot,
  buildDirectionArrow,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
  measureTextWidth,
  xmlEscape,
} = require('../common');
const { isArticulated } = require('../../bus/fleet');

const BUS_COLOR = 'ff2a6d'; // hot pink/red reads well on dark
const CONTEXT_PAD_FT = 1500; // feet of route context on each side of the bunch
const BUS_MARKER_RADIUS = 34;
const TERMINAL_MARKER_RADIUS = BUS_MARKER_RADIUS;
const STOP_MARKER_SIZE = 32;
const STOP_DOT_RADIUS = 6;
const RECORD_BADGE_TITLE = 'CTA BUS BUNCHING RECORD';
const RECORD_BADGE_SUBTITLE = 'Network-highest in last 30 days';
let recordBadgeSvgPromise = null;
// Push stops sideways off the route so the route line stays unbroken and
// the glyph isn't competing with the polyline for the same pixels. Offset
// is in the right-of-travel direction (perpendicular to view bearing).
const STOP_OFFSET_PX = 22;
const STOP_DOT_OFFSET_PX = 14;

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

async function buildRecordBadgeSvg() {
  if (!recordBadgeSvgPromise) {
    recordBadgeSvgPromise = (async () => {
      const titleSize = 28;
      const subtitleSize = 18;
      const titleWidth = await measureTextWidth(RECORD_BADGE_TITLE, titleSize, { bold: true });
      const subtitleWidth = await measureTextWidth(RECORD_BADGE_SUBTITLE, subtitleSize, {
        bold: false,
      });
      const accentW = 72;
      const gap = 20;
      const padX = 22;
      const x = 44;
      const y = 46;
      const textX = accentW + gap + padX;
      const contentW = Math.max(titleWidth, subtitleWidth);
      const width = textX + contentW + padX;
      const height = 104;
      const titleY = 40;
      const subtitleY = 72;
      const accentX = 18;
      const accentY = 16;
      const accentH = height - accentY * 2;
      const accentCx = accentX + accentW / 2;

      return `
    <defs>
      <linearGradient id="recordBadgeShell" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0d1720" stop-opacity="0.96"/>
        <stop offset="100%" stop-color="#071018" stop-opacity="0.86"/>
      </linearGradient>
      <linearGradient id="recordBadgeAccent" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#ffd970"/>
        <stop offset="100%" stop-color="#ff9d2e"/>
      </linearGradient>
      <filter id="recordBadgeShadow" x="-20%" y="-20%" width="160%" height="180%">
        <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.42"/>
      </filter>
    </defs>
    <g transform="translate(${x} ${y})" filter="url(#recordBadgeShadow)">
      <rect x="0" y="0" width="${width}" height="${height}" rx="28" fill="url(#recordBadgeShell)" stroke="#f7cc67" stroke-opacity="0.55" stroke-width="2"/>
      <rect x="${accentX}" y="${accentY}" width="${accentW}" height="${accentH}" rx="22" fill="url(#recordBadgeAccent)"/>
      <text x="${accentCx}" y="46" fill="#1b1407" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="800">30D</text>
      <text x="${accentCx}" y="67" fill="#1b1407" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="1">HIGH</text>
      <text x="${textX}" y="${titleY}" fill="#fff5d8" font-family="Helvetica, Arial, sans-serif" font-size="${titleSize}" font-weight="800">${xmlEscape(RECORD_BADGE_TITLE)}</text>
      <rect x="${textX}" y="50" width="${Math.max(150, Math.round(subtitleWidth + 12))}" height="2.5" rx="1.25" fill="#f7cc67" fill-opacity="0.75"/>
      <text x="${textX}" y="${subtitleY}" fill="#d6e5ef" font-family="Helvetica, Arial, sans-serif" font-size="${subtitleSize}" font-weight="600">${xmlEscape(RECORD_BADGE_SUBTITLE)}</text>
    </g>
  `;
    })();
  }
  return recordBadgeSvgPromise;
}

// Composite bus markers, traffic-signal dots, stop glyphs, and the direction
// arrow onto a pre-fetched base map. The base map, signals, stops, and arrow
// are static across a video; only marker positions vary.
async function renderBunchingFrame(view, baseMap, vehicles, signals = [], stops = [], opts = {}) {
  const compactStops = opts.compactStops === true;
  const compactSignals = opts.compactSignals === true;
  const recordBadge = opts.recordBadge === true ? await buildRecordBadgeSvg() : '';
  // Signals render below buses — small traffic-light glyphs that read clearly
  // without competing with the primary markers. Drawn inline (not via Unicode)
  // so librsvg renders the same shape on every host. Housings rotate to sit
  // perpendicular to the route: horizontal (E-W) streets get vertical signals,
  // N-S streets get horizontal ones — matching how real lights face drivers.
  // Full mode: dark housing rectangle with 3 lamp circles. Compact mode
  // (used by video frames) drops the housing and renders just three small
  // red/yellow/green dots in a line — same orientation logic so a row of
  // dots still reads as "traffic light" without dominating the frame.
  const SIGNAL_LONG = 36;
  const SIGNAL_SHORT = 16;
  const SIGNAL_DOT_R = compactSignals ? 5 : 4;
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
    const housing = compactSignals
      ? ''
      : `<rect x="${left}" y="${top}" width="${w}" height="${h}" rx="4" ry="4" fill="#1c1c1c" stroke="#fff" stroke-width="1.5"/>`;
    return [
      housing,
      vertical
        ? `<circle cx="${x}" cy="${top + redOff}" r="${SIGNAL_DOT_R}" fill="#e53935"/>`
        : `<circle cx="${left + redOff}" cy="${y}" r="${SIGNAL_DOT_R}" fill="#e53935"/>`,
      vertical
        ? `<circle cx="${x}" cy="${top + yellowOff}" r="${SIGNAL_DOT_R}" fill="#fdd835"/>`
        : `<circle cx="${left + yellowOff}" cy="${y}" r="${SIGNAL_DOT_R}" fill="#fdd835"/>`,
      vertical
        ? `<circle cx="${x}" cy="${top + greenOff}" r="${SIGNAL_DOT_R}" fill="#43a047"/>`
        : `<circle cx="${left + greenOff}" cy="${y}" r="${SIGNAL_DOT_R}" fill="#43a047"/>`,
    ].join('');
  });
  // Stop glyphs render below buses (and below terminals/arrow) so a bus
  // sitting at a stop still reads on top. Each stop carries its own local
  // bearing from getPatternStops, so curved sections push perpendicular
  // to the local segment instead of skewing to one side. Every stop sits
  // at the same fixed offset for a uniform parade-of-signs look — signals
  // are NOT pushed around, so they may sit adjacent to the route line
  // while the stop sits cleanly beside the same intersection. Stops that
  // land within a marker-width of an already-placed stop are dropped, so
  // paired near-side/far-side stops don't read as one blob.
  // In compact mode (used by video frames where the full sign reads as
  // visual noise on dense routes) stops render as small amber dots and sit
  // closer to the route. Still images keep the full sign glyph.
  const offsetPx = compactStops ? STOP_DOT_OFFSET_PX : STOP_OFFSET_PX;
  const minSeparation = compactStops ? STOP_DOT_RADIUS * 2 + 4 : STOP_MARKER_SIZE + 6;
  const placedStops = [];
  const stopElements = [];
  for (const s of stops) {
    const perp = perpendicularFromBearing(s.bearing ?? view.bearingDeg);
    const p = project(s.lat, s.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT);
    const x = p.x + perp.x * offsetPx;
    const y = p.y + perp.y * offsetPx;
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue;
    const tooClose = placedStops.some((q) => Math.hypot(q.x - x, q.y - y) < minSeparation);
    if (tooClose) continue;
    placedStops.push({ x, y });
    stopElements.push(
      compactStops ? buildStopDot(x, y, STOP_DOT_RADIUS) : buildStopMarker(x, y, STOP_MARKER_SIZE),
    );
  }

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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${signalElements.join('\n')}${stopElements.join('\n')}${terminalElements.join('\n')}${markerElements.join('\n')}${arrowElements.join('\n')}${recordBadge}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function renderBunchingMap(bunch, pattern, signals = [], stops = []) {
  const view = computeBunchingView(bunch, pattern);
  const baseMap = await fetchBunchingBaseMap(view);
  return renderBunchingFrame(view, baseMap, bunch.vehicles, signals, stops);
}

module.exports = {
  renderBunchingMap,
  computeBunchingView,
  fetchBunchingBaseMap,
  renderBunchingFrame,
};
