const sharp = require('sharp');
const { encode } = require('../shared/polyline');
const { fitZoom, project } = require('../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  requireMapboxToken,
  fetchMapboxStatic,
  xmlEscape,
  measureTextWidth,
  paddedBbox,
  bboxOf,
} = require('./common');
const { LINE_NAMES } = require('../train/api');

// Equirectangular — fine for ranking nearest vertex over central Chicago.
function latLonDistMeters([lat, lon], loc) {
  const dLat = (lat - loc.lat) * 111320;
  const dLon = (lon - loc.lon) * 111320 * Math.cos((loc.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function _findNearestIndex(poly, loc) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = latLonDistMeters(poly[i], loc);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { index: best, distMeters: bestD };
}

// Walk the polyline by arc-length and dim the contiguous run between the
// vertices closest to fromLoc and toLoc. Earlier we projected vertices onto
// the Euclidean from→to axis, but on lines that double back near the
// affected stretch (Blue Line continues west out the Eisenhower past
// LaSalle, Purple round-trips through the Loop) lateral vertices project
// back into [0,1] and get dimmed even though they're topologically past the
// affected segment. Per-segment arc-length splitting handles both cases.
function splitSegments(segments, fromLoc, toLoc) {
  const active = [];
  const suspended = [];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    const fromIdx = nearestVertexIdx(seg, fromLoc);
    const toIdx = nearestVertexIdx(seg, toLoc);
    // If from/to don't both land on this segment with a meaningful split,
    // leave the whole thing bright. Picking an arbitrary slice would dim
    // the wrong branch on multi-segment lines.
    if (fromIdx == null || toIdx == null || fromIdx === toIdx) {
      active.push(seg);
      continue;
    }
    // Replace the nearest-vertex boundaries with the real station coords so
    // the dim/bright join lands at the station instead of a few hundred feet
    // shy of it (polyline vertices aren't placed at stations).
    const snapped = seg.slice();
    snapped[fromIdx] = [fromLoc.lat, fromLoc.lon];
    snapped[toIdx] = [toLoc.lat, toLoc.lon];
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    if (lo > 0) active.push(snapped.slice(0, lo + 1));
    suspended.push(snapped.slice(lo, hi + 1));
    if (hi < snapped.length - 1) active.push(snapped.slice(hi));
  }
  return { active, suspended };
}

function nearestVertexIdx(seg, loc) {
  let bestIdx = -1;
  let bestD = Infinity;
  for (let i = 0; i < seg.length; i++) {
    const d = latLonDistMeters(seg[i], loc);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  // Reject snaps that are absurdly far — those mean the station isn't on
  // this segment (e.g. trying to dim a Forest Park station on the O'Hare-only
  // segment if the polyline ever gets split into branches).
  return bestD < 4000 ? bestIdx : null;
}

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

async function renderDisruption({
  disruption,
  trainLines,
  lineColors,
  trains = [],
  stations,
  title,
}) {
  const { line, suspendedSegment } = disruption;
  const color = lineColors[line] || 'ffffff';
  const segments = trainLines[line] || [];
  if (segments.length === 0) throw new Error(`No polyline data for line ${line}`);

  const fromLoc = resolveStation(stations, line, suspendedSegment.from);
  const toLoc = resolveStation(stations, line, suspendedSegment.to);
  if (!fromLoc)
    throw new Error(`Could not resolve station "${suspendedSegment.from}" on line ${line}`);
  if (!toLoc) throw new Error(`Could not resolve station "${suspendedSegment.to}" on line ${line}`);

  const { active, suspended } = splitSegments(segments, fromLoc, toLoc);

  const overlays = [];
  // Suspended: line color at reduced opacity + thinner stroke for contrast.
  for (const seg of suspended) {
    if (!seg || seg.length < 2) continue;
    overlays.push(`path-4+${color}-0.4(${encodeURIComponent(encode(seg))})`);
  }
  for (const seg of active) {
    if (!seg || seg.length < 2) continue;
    overlays.push(`path-10+${color}-0.95(${encodeURIComponent(encode(seg))})`);
  }
  for (const t of trains) {
    if (t.line !== line) continue;
    overlays.push(`pin-s+${color}(${t.lon.toFixed(4)},${t.lat.toFixed(4)})`);
  }

  // Frame on the suspended stretch + buffer; citywide zoom would lose short suspensions.
  const flatSuspended = suspended.flat();
  if (flatSuspended.length === 0) {
    throw new Error(
      `splitSegments produced empty suspended polyline for ${line} ${suspendedSegment.from}→${suspendedSegment.to} — refusing to render with NaN bbox`,
    );
  }
  const bbox = paddedBbox(bboxOf(flatSuspended), 0.5, 0.02);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.min(13, fitZoom(bbox, WIDTH, HEIGHT, 120));

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  const baseMap = await fetchMapboxStatic(url);

  const lineName = LINE_NAMES[line] || line;
  const titleText = title || `⚠ ${lineName} Line suspended`;
  const titleFontSize = 42;
  // Real glyph measurement via the same renderer that draws the SVG. Earlier
  // estimators (flat 24px/char, then per-glyph ratios) drifted on each new
  // title format and either clipped the text or trailed dead space.
  const titleWidth = 48 + (await measureTextWidth(titleText, titleFontSize, { bold: true }));

  const fromPx = project(fromLoc.lat, fromLoc.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const toPx = project(toLoc.lat, toLoc.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const labels = (
    await Promise.all([stationLabel(fromLoc.name, fromPx), stationLabel(toLoc.name, toPx)])
  )
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

// Title-pill keepout — labels that would intersect get flipped below the dot.
const TITLE_KEEPOUT = { x: 0, y: 0, w: 800, h: 130 };

async function stationLabel(name, px) {
  if (!name || !Number.isFinite(px.x) || !Number.isFinite(px.y)) return '';
  const text = name.split(' (')[0]; // drop "(Red)" style line disambiguation
  const fontSize = 28;
  const pad = 12;
  // Real measurement so long names ("Cumberland", "Garfield (Green)" etc.)
  // never overrun the pill regardless of glyph mix.
  const textW = await measureTextWidth(text, fontSize);
  const pillW = textW + pad * 2;
  const h = fontSize + pad * 1.4;
  const xPill = Math.round(px.x - pillW / 2);

  // Default: pill above the dot. Flip below if it would cross the title
  // keepout or go off the top edge.
  const above = Math.round(px.y - h - 14);
  const below = Math.round(px.y + 14);
  const wouldHitTitle =
    above < TITLE_KEEPOUT.y + TITLE_KEEPOUT.h &&
    xPill < TITLE_KEEPOUT.x + TITLE_KEEPOUT.w &&
    xPill + pillW > TITLE_KEEPOUT.x;
  const y = above < 8 || wouldHitTitle ? below : above;

  return [
    `<rect x="${xPill}" y="${y}" width="${Math.round(pillW)}" height="${Math.round(h)}" fill="#000" fill-opacity="0.82" rx="8"/>`,
    `<text x="${Math.round(px.x)}" y="${Math.round(y + h - pad)}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${xmlEscape(text)}</text>`,
    `<circle cx="${Math.round(px.x)}" cy="${Math.round(px.y)}" r="7" fill="#fff" stroke="#000" stroke-width="3"/>`,
  ].join('');
}

module.exports = { renderDisruption, splitSegments, resolveStation };
