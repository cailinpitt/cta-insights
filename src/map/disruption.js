const sharp = require('sharp');
const { encode } = require('../shared/polyline');
const { fitZoom, project } = require('../shared/projection');
const {
  STYLE, WIDTH, HEIGHT,
  requireMapboxToken, fetchMapboxStatic,
  xmlEscape,
} = require('./common');
const { LINE_NAMES } = require('../train/api');

// Rough meters between a [lat, lon] tuple and a { lat, lon } object.
// Good enough for ranking nearest polyline vertex to a station (short
// distances over central Chicago); not a great-circle computation.
function latLonDistMeters([lat, lon], loc) {
  const dLat = (lat - loc.lat) * 111320;
  const dLon = (lon - loc.lon) * 111320 * Math.cos(loc.lat * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

function findNearestIndex(poly, loc) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = latLonDistMeters(poly[i], loc);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, distMeters: bestD };
}

// Split each polyline segment into "active" and "suspended" runs by walking
// the polyline and projecting every vertex onto the from→to axis. A vertex
// is "in the affected stretch" when its projection parameter t lies in
// [~0, ~1] — i.e. between the two stations along the direction of travel.
//
// Projection (not bbox) is the right call because it:
//   1. ends the dim region exactly at the station (no buffer overshoot past
//      Thorndale like a bbox pad would cause), and
//   2. naturally handles round-trip polylines — the Purple Line runs
//      Linden → Howard → Loop → Howard → Linden, and both passes through
//      the Linden↔Howard stretch produce t ∈ [0, 1], so both get dimmed
//      and the bright return leg can't sit on top of the dim forward leg.
function splitSegments(segments, fromLoc, toLoc) {
  // Work in a rough equirectangular pixel space so the projection handles
  // lat/lon with equal weighting at Chicago's latitude. (Raw lat/lon would
  // squash longitude distances since a degree of lon ≈ 0.74 × a degree of
  // lat at 41.9°.)
  const cosLat = Math.cos(fromLoc.lat * Math.PI / 180);
  const toXY = ([lat, lon]) => ({ x: lon * cosLat, y: lat });
  const A = toXY([fromLoc.lat, fromLoc.lon]);
  const B = toXY([toLoc.lat, toLoc.lon]);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const abLen2 = abx * abx + aby * aby;
  const T_MIN = -0.02;
  const T_MAX = 1.02;
  const inAffected = (pt) => {
    const p = toXY(pt);
    const t = ((p.x - A.x) * abx + (p.y - A.y) * aby) / abLen2;
    return t >= T_MIN && t <= T_MAX;
  };

  const active = [];
  const suspended = [];
  for (const seg of segments) {
    let current = [];
    let currentIsSuspended = null;
    const flush = () => {
      if (current.length >= 2) {
        (currentIsSuspended ? suspended : active).push(current);
      }
      current = [];
    };
    for (const pt of seg) {
      const isIn = inAffected(pt);
      if (currentIsSuspended === null) {
        currentIsSuspended = isIn;
        current.push(pt);
      } else if (isIn === currentIsSuspended) {
        current.push(pt);
      } else {
        // Transition vertex belongs to both runs — otherwise there's a
        // visible gap between the dim and bright polylines.
        current.push(pt);
        flush();
        currentIsSuspended = isIn;
        current.push(pt);
      }
    }
    flush();
  }
  return { active, suspended };
}

// Resolve a station name on a given line to {lat, lon}. Prefers stations
// that list the line; falls back to any station if needed.
function resolveStation(stations, line, name) {
  const norm = name.toLowerCase();
  const onLine = stations.filter((s) => s.lines?.includes(line));
  for (const pool of [onLine, stations]) {
    for (const s of pool) {
      if (s.name.toLowerCase() === norm) return { lat: s.lat, lon: s.lon, name: s.name };
    }
    for (const s of pool) {
      const base = s.name.toLowerCase().split(' (')[0];
      if (base === norm || base.startsWith(norm) || norm.startsWith(base)) {
        return { lat: s.lat, lon: s.lon, name: s.name };
      }
    }
  }
  return null;
}

async function renderDisruption({ disruption, trainLines, lineColors, trains = [], stations }) {
  const { line, suspendedSegment } = disruption;
  const color = lineColors[line] || 'ffffff';
  const segments = trainLines[line] || [];
  if (segments.length === 0) throw new Error(`No polyline data for line ${line}`);

  const fromLoc = resolveStation(stations, line, suspendedSegment.from);
  const toLoc = resolveStation(stations, line, suspendedSegment.to);
  if (!fromLoc) throw new Error(`Could not resolve station "${suspendedSegment.from}" on line ${line}`);
  if (!toLoc) throw new Error(`Could not resolve station "${suspendedSegment.to}" on line ${line}`);

  const { active, suspended } = splitSegments(segments, fromLoc, toLoc);

  const overlays = [];
  // Suspended segments render in the line color at reduced opacity — keeps
  // the line's identity ("this is the Yellow Line") while the thinner stroke
  // + dimmer alpha contrast against the active stretch's bright thick line.
  for (const seg of suspended) {
    if (!seg || seg.length < 2) continue;
    overlays.push(`path-4+${color}-0.4(${encodeURIComponent(encode(seg))})`);
  }
  for (const seg of active) {
    if (!seg || seg.length < 2) continue;
    overlays.push(`path-10+${color}-0.95(${encodeURIComponent(encode(seg))})`);
  }
  // Live trains on this line as small pins — helpful context: readers see
  // where service currently exists and where it's absent.
  for (const t of trains) {
    if (t.line !== line) continue;
    overlays.push(`pin-s+${color}(${t.lon.toFixed(4)},${t.lat.toFixed(4)})`);
  }

  // Frame on the suspended stretch (plus buffer) rather than the whole line.
  // Readers care about where service is out, not the full route; the dim
  // segment gets lost at citywide zoom for short suspensions.
  const bbox = paddedBbox(bboxOf(suspended.flat()), 0.5, 0.02);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.min(13, fitZoom(bbox, WIDTH, HEIGHT, 120));

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  const baseMap = await fetchMapboxStatic(url);

  const lineName = LINE_NAMES[line] || line;
  const titleText = `⚠ ${lineName} Line suspended`;
  const titleWidth = 90 + titleText.length * 24;

  // Project the two suspension endpoints so we can label them by name.
  // Labels render as dark pills with white text — works on any basemap tile.
  const fromPx = project(fromLoc.lat, fromLoc.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const toPx = project(toLoc.lat, toLoc.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const labels = [stationLabel(fromLoc.name, fromPx), stationLabel(toLoc.name, toPx)]
    .filter(Boolean)
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect x="24" y="24" width="${titleWidth}" height="88" fill="#000" fill-opacity="0.78" rx="10"/>
    <text x="48" y="84" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="42" font-weight="700">${xmlEscape(titleText)}</text>
    ${labels}
  </svg>`;

  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

function bboxOf(points) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

// Expand a bbox by a fractional margin plus a minimum degrees floor.
// The floor keeps very short suspensions (a single stop-pair) from
// producing a street-level zoom with no surrounding context.
function paddedBbox(bbox, fracMargin, minSpanDeg) {
  const latSpan = Math.max(bbox.maxLat - bbox.minLat, minSpanDeg);
  const lonSpan = Math.max(bbox.maxLon - bbox.minLon, minSpanDeg);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const padLat = latSpan * (1 + fracMargin) / 2;
  const padLon = lonSpan * (1 + fracMargin) / 2;
  return {
    minLat: centerLat - padLat,
    maxLat: centerLat + padLat,
    minLon: centerLon - padLon,
    maxLon: centerLon + padLon,
  };
}

// Reserve the top-left for the title pill so station labels don't crash
// into it. If a label would land inside this box, we flip it below the dot.
const TITLE_KEEPOUT = { x: 0, y: 0, w: 800, h: 130 };

function stationLabel(name, px) {
  if (!name || !Number.isFinite(px.x) || !Number.isFinite(px.y)) return '';
  const text = name.split(' (')[0]; // drop "(Red)" style line disambiguation
  const fontSize = 28;
  const pad = 12;
  const approxW = text.length * (fontSize * 0.58) + pad * 2;
  const h = fontSize + pad * 1.4;
  const xPill = Math.round(px.x - approxW / 2);

  // Default: pill above the dot. Flip below if it would cross the title
  // keepout or go off the top edge.
  const above = Math.round(px.y - h - 14);
  const below = Math.round(px.y + 14);
  const wouldHitTitle = above < TITLE_KEEPOUT.y + TITLE_KEEPOUT.h
    && xPill < TITLE_KEEPOUT.x + TITLE_KEEPOUT.w
    && xPill + approxW > TITLE_KEEPOUT.x;
  const y = (above < 8 || wouldHitTitle) ? below : above;

  return [
    `<rect x="${xPill}" y="${y}" width="${Math.round(approxW)}" height="${Math.round(h)}" fill="#000" fill-opacity="0.82" rx="8"/>`,
    `<text x="${Math.round(px.x)}" y="${Math.round(y + h - pad)}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${xmlEscape(text)}</text>`,
    `<circle cx="${Math.round(px.x)}" cy="${Math.round(px.y)}" r="7" fill="#fff" stroke="#000" stroke-width="3"/>`,
  ].join('');
}

module.exports = { renderDisruption, splitSegments, resolveStation };
