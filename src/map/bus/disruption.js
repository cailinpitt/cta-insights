const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { fitZoom } = require('../../shared/projection');
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
  measureTextWidth,
  paddedBbox,
  bboxOf,
} = require('../common');

// Cap routes drawn so the Mapbox URL stays under its 8KB limit and the map
// doesn't turn into a citywide tangle. Multi-route alerts beyond this fall
// back to text-only.
const MAX_ROUTES = 5;

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
  const titleFontSize = 42;
  // Measure with the same renderer that draws the SVG so the pill always
  // hugs the text — earlier we used a per-glyph estimator that drifted with
  // every new title format and kept clipping (e.g. "service impact" titles).
  const titleWidth = 48 + (await measureTextWidth(titleText, titleFontSize, { bold: true }));
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

module.exports = { renderBusDisruption, MAX_ROUTES };
