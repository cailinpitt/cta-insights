const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { fitZoom, project } = require('../../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  ROUTE_HALO_STROKE,
  ROUTE_CORE_COLOR,
  ROUTE_CORE_STROKE,
  requireMapboxToken,
  fetchMapboxStatic,
  xmlEscape,
  fitTitlePill,
  paddedBbox,
  bboxOf,
} = require('../common');
const { pairedStationLabels } = require('../disruption');

// Cap routes drawn so the Mapbox URL stays under its 8KB limit and the map
// doesn't turn into a citywide tangle. Multi-route alerts beyond this fall
// back to text-only.
const MAX_ROUTES = 5;

// Dim/active styling for the rich single-route renderer. Same shape as the
// train disruption renderer so the brand is consistent. Bus dim opacity is
// lower than train (0.4 → 0.18) because bus polylines are denser through
// the same screen area — at 0.4 the dim stretch reads almost as bright as
// the active stretch and the focus zone disappears.
const DIM_OPACITY = 0.18;
const ACTIVE_OPACITY = 1.0;
const SEGMENT_STROKE = 10;
const FOCUS_HIGHLIGHT_STROKE = 16;

async function renderBusDisruption({ routes, getKnownPidsForRoute, loadPattern, title }) {
  if (!routes || routes.length === 0 || routes.length > MAX_ROUTES) return null;

  const polylinesByRoute = new Map();
  const allPoints = [];
  for (const route of routes) {
    const pids = (await getKnownPidsForRoute(route)) || [];
    if (pids.length === 0) continue;
    const patterns = [];
    for (const pid of pids) {
      try {
        const p = await loadPattern(pid);
        if (p?.points?.length >= 2) patterns.push(p);
      } catch (_e) {
        /* skip */
      }
    }
    if (patterns.length === 0) continue;
    // Pick the single longest pattern. CTA bus pids come in pairs
    // (NB/SB) that often run on a one-way street pair through downtown —
    // drawing both produces a parallel doubled line that reads as visual
    // noise. One pattern is enough to convey "is this my route?", the
    // sole question this map answers.
    const canonical = patterns.reduce((a, b) => (a.points.length >= b.points.length ? a : b));
    const coords = canonical.points.map((pt) => [pt.lat, pt.lon]);
    polylinesByRoute.set(String(route), [coords]);
    for (const [lat, lon] of coords) allPoints.push([lat, lon]);
  }
  if (polylinesByRoute.size === 0 || allPoints.length === 0) return null;

  const bbox = paddedBbox(bboxOf(allPoints), 0.1, 0.01);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  // Floor + a citywide-ish ceiling. Bus routes can span the city north-south,
  // so the floor only matters when the route is short or single-segment.
  const zoom = Math.max(8, Math.min(13, Math.floor(fitZoom(bbox, WIDTH, HEIGHT, 80))));

  const overlays = [];
  for (const polys of polylinesByRoute.values()) {
    for (const poly of polys) {
      const enc = encodeURIComponent(encode(poly));
      // Halo first, then bright core on top.
      overlays.push(`path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${enc})`);
      overlays.push(`path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${enc})`);
    }
  }

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  // Mapbox static caps URL at ~8192 chars. If we blew past that we'd 414 —
  // skip rendering so the bin falls back to text-only.
  if (url.length > 8000) return null;
  const baseMap = await fetchMapboxStatic(url);

  const titleText = title;
  // Measure with the same renderer that draws the SVG so the pill always
  // hugs the text — earlier we used a per-glyph estimator that drifted with
  // every new title format and kept clipping. Shrink the font when a long
  // title would overflow the canvas (e.g. "#53A South Pulaski service
  // appears suspended" at 42px exceeds 1200px wide).
  const { fontSize: titleFontSize, pillWidth: titleWidth } = await fitTitlePill(
    titleText,
    42,
    WIDTH - 48,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect x="24" y="24" width="${titleWidth}" height="88" fill="#000" fill-opacity="0.78" rx="10"/>
    <text x="48" y="84" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="${titleFontSize}" font-weight="700">${xmlEscape(titleText)}</text>
  </svg>`;

  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

// Walk pattern.points (which carries pdist on each vertex from CTA) and
// split into [beforeFocus, insideFocus, afterFocus] coord arrays. Each is a
// list of [lat, lon] pairs ready for polyline encoding. If pdist is missing
// on the pattern, falls back to no split (whole route returned as `before`).
function splitPatternByPdist(pattern, focusLoFt, focusHiFt) {
  const before = [];
  const inside = [];
  const after = [];
  let lastBucket = null;
  let lastPoint = null;
  for (const pt of pattern.points || []) {
    if (pt.pdist == null || pt.lat == null || pt.lon == null) continue;
    let bucket;
    if (pt.pdist < focusLoFt) bucket = 'before';
    else if (pt.pdist > focusHiFt) bucket = 'after';
    else bucket = 'inside';
    // To keep adjacent segments visually contiguous (no white pixel gap when
    // dim and active strokes meet), repeat the boundary vertex into the next
    // bucket as we cross it.
    if (lastBucket && bucket !== lastBucket && lastPoint) {
      const target = bucket === 'before' ? before : bucket === 'inside' ? inside : after;
      target.push([lastPoint.lat, lastPoint.lon]);
    }
    if (bucket === 'before') before.push([pt.lat, pt.lon]);
    else if (bucket === 'inside') inside.push([pt.lat, pt.lon]);
    else after.push([pt.lat, pt.lon]);
    lastBucket = bucket;
    lastPoint = pt;
  }
  return { before, inside, after };
}

function nearestPointAtPdist(pattern, targetPdist) {
  let best = null;
  let bestDelta = Infinity;
  for (const pt of pattern.points || []) {
    if (pt.pdist == null || pt.lat == null || pt.lon == null) continue;
    const delta = Math.abs(pt.pdist - targetPdist);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = pt;
    }
  }
  return best;
}

function nearestStopOnPattern(pattern, targetPdist) {
  let best = null;
  let bestDelta = Infinity;
  for (const pt of pattern.points || []) {
    if (pt.type !== 'S' || !pt.stopName || pt.pdist == null) continue;
    const delta = Math.abs(pt.pdist - targetPdist);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = pt;
    }
  }
  return best;
}

function terminalStops(pattern) {
  const stops = (pattern.points || []).filter((p) => p.type === 'S' && p.stopName);
  if (stops.length < 2) return null;
  return { from: stops[0], to: stops[stops.length - 1] };
}

// Rich single-route renderer used by held-cluster + blackout posts. Either
// draws the full route dimmed (for blackouts where the entire route is
// silent) or splits the route into dimmed-outside + bright-focus (for
// held-cluster + extracted-from-CTA-alert "between X and Y" posts).
//
// `focusZone` (optional): { centerPdist, halfWidthFt } — the affected stretch
// in pdist space. When present, the render dims everything outside and
// highlights the focus + drops a 🛑 pin at the centroid.
//
// `mode`: 'held' | 'blackout' | 'segment'. Drives marker + framing only.
async function renderBusDisruptionRich({ route, pattern, focusZone, title, mode = 'segment' }) {
  if (!pattern || !pattern.points || pattern.points.length < 2) return null;

  const allCoords = pattern.points
    .filter((pt) => pt.lat != null && pt.lon != null)
    .map((pt) => [pt.lat, pt.lon]);
  if (allCoords.length < 2) return null;

  // Split the polyline if we have a focus zone, otherwise treat the whole
  // route as dimmed (blackout).
  let dim = [allCoords];
  let active = [];
  let focusCenter = null;
  let focusBoundaryStops = [];

  if (focusZone && Number.isFinite(focusZone.centerPdist)) {
    const halfWidth = focusZone.halfWidthFt || 1320;
    const rawLo = focusZone.centerPdist - halfWidth;
    const rawHi = focusZone.centerPdist + halfWidth;
    // Snap the focus zone outward to the labeled boundary stops so the
    // bright red segment actually reaches the labels — otherwise the
    // segment stops short of the labeled "Sheridan & Ardmore"-style
    // bookends and the labels look unanchored.
    const fromStop = nearestStopOnPattern(pattern, rawLo);
    const toStop = nearestStopOnPattern(pattern, rawHi);
    const lo = fromStop ? Math.min(rawLo, fromStop.pdist) : rawLo;
    const hi = toStop ? Math.max(rawHi, toStop.pdist) : rawHi;
    const split = splitPatternByPdist(pattern, lo, hi);
    if (split.inside.length >= 2) {
      dim = [];
      if (split.before.length >= 2) dim.push(split.before);
      if (split.after.length >= 2) dim.push(split.after);
      active = [split.inside];
    }
    focusCenter = nearestPointAtPdist(pattern, focusZone.centerPdist);
    if (fromStop) focusBoundaryStops.push(fromStop);
    if (toStop && (!fromStop || toStop.stopName !== fromStop.stopName)) {
      focusBoundaryStops.push(toStop);
    }
  } else {
    // Blackout: dim the whole route, label the terminals.
    const terms = terminalStops(pattern);
    if (terms) focusBoundaryStops = [terms.from, terms.to];
  }

  // Frame: focus zone if present (with breathing room), otherwise full route.
  const framePoints = active.length > 0 ? active.flat() : allCoords;
  const bbox = paddedBbox(
    bboxOf(framePoints),
    active.length > 0 ? 0.6 : 0.1,
    active.length > 0 ? 0.01 : 0.01,
  );
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.max(8, Math.min(15, fitZoom(bbox, WIDTH, HEIGHT, 80)));

  const overlays = [];
  // Dim FIRST (lower z) so the active stretch draws on top and stays bright.
  // The opposite order (train renderer) made sense because the train's
  // suspended span needed to cover bright cap overlap. Bus held framing is
  // the inverse — the bright focus zone is the message, the dim outside is
  // the context.
  for (const seg of dim) {
    if (seg.length < 2) continue;
    const enc = encodeURIComponent(encode(seg));
    overlays.push(`path-${SEGMENT_STROKE}+${ROUTE_CORE_COLOR}-${DIM_OPACITY}(${enc})`);
  }
  // Active stretch in red for held mode (alarm color) or route cyan for the
  // CTA-alert "between X and Y" segment mode. Drawn thicker so it visually
  // dominates the dim outline even at a citywide zoom.
  const activeColor = mode === 'held' ? 'ff3030' : ROUTE_CORE_COLOR;
  for (const seg of active) {
    if (seg.length < 2) continue;
    const enc = encodeURIComponent(encode(seg));
    overlays.push(`path-${FOCUS_HIGHLIGHT_STROKE}+${activeColor}-${ACTIVE_OPACITY}(${enc})`);
  }
  // No centroid pin: the bright red focus segment + the labeled boundary
  // stops already say "stuck here", and a pin on top reads as an
  // unexplained marker.

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  if (url.length > 8000) return null;
  const baseMap = await fetchMapboxStatic(url);

  const titleText = title || `⚠ Route ${route} · service impact`;
  const { fontSize: titleFontSize, pillWidth: titleWidth } = await fitTitlePill(
    titleText,
    42,
    WIDTH - 48,
  );

  // Project focus boundary stops to pixel space so we can label them with the
  // same paired-label treatment trains use.
  const labels = await pairedStationLabels(
    focusBoundaryStops.slice(0, 3).map((s) => ({
      name: s.stopName,
      px: project(s.lat, s.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT),
    })),
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect x="24" y="24" width="${titleWidth}" height="88" fill="#000" fill-opacity="0.82" rx="10"/>
    <text x="48" y="84" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="${titleFontSize}" font-weight="700">${xmlEscape(titleText)}</text>
    ${labels}
  </svg>`;

  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

module.exports = {
  renderBusDisruption,
  renderBusDisruptionRich,
  splitPatternByPdist,
  nearestStopOnPattern,
  terminalStops,
  MAX_ROUTES,
};
