const sharp = require('sharp');
const { encode } = require('../shared/polyline');
const { fitZoom, project } = require('../shared/projection');
const {
  STYLE, WIDTH, HEIGHT,
  requireMapboxToken, fetchMapboxStatic,
  xmlEscape,
} = require('./common');

// Explicit citywide bbox so circle projection is deterministic. North reaches
// Linden/Dempster-Skokie; south reaches 95th/Dan Ryan.
const CHICAGO_BBOX = {
  minLat: 41.64,
  maxLat: 42.08,
  minLon: -87.92,
  maxLon: -87.52,
};

// Five lines share the Loop rectangle, so chronic downtown spots merge into
// one dot at citywide zoom. The inset frames the same area as the snapshot post.
const LOOP_BBOX = {
  minLat: 41.874,
  maxLat: 41.891,
  minLon: -87.638,
  maxLon: -87.622,
};
const LOOP_INSET_SIZE = 400;
const LOOP_INSET_MARGIN = 20;

const CIRCLE_COLOR = '#ff2a6d';
const CIRCLE_STROKE = '#fff';
// Log scaling so 10 incidents → ~3× a 1-incident spot, not 10×.
function radiusForCount(count) {
  return Math.round(12 + 14 * Math.log2(count + 1));
}

function buildCircles(points, centerLat, centerLon, zoom, width, height, radiusFn) {
  // Smallest-first → bigger circles paint last (SVG = document order).
  const sortedPoints = [...points].sort((a, b) => a.count - b.count);
  return sortedPoints.map((p) => {
    const { x, y } = project(p.lat, p.lon, centerLat, centerLon, zoom, width, height);
    if (x < -50 || x > width + 50 || y < -50 || y > height + 50) return '';
    const r = radiusFn(p.count);
    const fontSize = Math.max(12, Math.round(r * 0.9));
    return [
      `<circle cx="${x}" cy="${y}" r="${r}" fill="${CIRCLE_COLOR}" fill-opacity="0.55" stroke="${CIRCLE_STROKE}" stroke-width="2"/>`,
      `<text x="${x}" y="${y + fontSize / 3}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" stroke="#000" stroke-width="2" paint-order="stroke">${p.count}</text>`,
    ].join('');
  });
}

async function renderLoopInset({ points, trainLines, lineColors }) {
  const inBbox = (lat, lon) =>
    lat >= LOOP_BBOX.minLat && lat <= LOOP_BBOX.maxLat &&
    lon >= LOOP_BBOX.minLon && lon <= LOOP_BBOX.maxLon;
  const loopPoints = points.filter((p) => inBbox(p.lat, p.lon));

  // Concentric rings so all five Loop-sharing lines stay visible.
  const RING_ORDER = ['brn', 'g', 'org', 'p', 'pink'];
  const ringIdx = Object.fromEntries(RING_ORDER.map((l, i) => [l, i]));
  const overlays = [];
  const entries = Object.entries(trainLines)
    .sort(([a], [b]) => (ringIdx[a] ?? -1) - (ringIdx[b] ?? -1));
  for (const [line, segments] of entries) {
    const color = lineColors[line] || 'ffffff';
    const width = line in ringIdx
      ? 4 + (RING_ORDER.length - 1 - ringIdx[line]) * 2
      : 4;
    for (const pts of segments) {
      if (!pts || pts.length < 2) continue;
      overlays.push(`path-${width}+${color}-0.85(${encodeURIComponent(encode(pts))})`);
    }
  }

  const centerLat = (LOOP_BBOX.minLat + LOOP_BBOX.maxLat) / 2;
  const centerLon = (LOOP_BBOX.minLon + LOOP_BBOX.maxLon) / 2;
  const rawZoom = fitZoom(LOOP_BBOX, LOOP_INSET_SIZE, LOOP_INSET_SIZE, 20);
  const zoom = Math.max(13, Math.min(17, Math.floor(rawZoom)));

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${LOOP_INSET_SIZE}x${LOOP_INSET_SIZE}@2x?access_token=${token}`;
  const baseMap = await fetchMapboxStatic(url);

  // Smaller radius so a count-7 dot doesn't swallow the Loop rectangle.
  const insetRadius = (count) => Math.round(8 + 8 * Math.log2(count + 1));
  const circles = buildCircles(loopPoints, centerLat, centerLon, zoom, LOOP_INSET_SIZE, LOOP_INSET_SIZE, insetRadius);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LOOP_INSET_SIZE}" height="${LOOP_INSET_SIZE}">
    ${circles.join('\n')}
    <rect x="2" y="2" width="${LOOP_INSET_SIZE - 4}" height="${LOOP_INSET_SIZE - 4}" fill="none" stroke="#fff" stroke-width="4"/>
    <rect x="10" y="10" width="104" height="32" fill="#000" fill-opacity="0.8" rx="3"/>
    <text x="62" y="32" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="600">The Loop</text>
  </svg>`;

  return sharp(baseMap)
    .resize(LOOP_INSET_SIZE, LOOP_INSET_SIZE)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

async function renderHeatmap({ points, kind, trainLines = null, lineColors = null }) {
  const bbox = CHICAGO_BBOX;
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 40);
  const zoom = Math.max(9, Math.min(13, rawZoom));

  // Train: overlay line shapes so circles sit on visible track. Bus: basemap
  // streets are enough context — 100+ route overlays would blow the URL limit.
  const overlays = [];
  if (kind === 'train' && trainLines && lineColors) {
    for (const [line, segments] of Object.entries(trainLines)) {
      const color = lineColors[line] || 'ffffff';
      for (const pts of segments) {
        if (!pts || pts.length < 2) continue;
        overlays.push(`path-2+${color}-0.6(${encodeURIComponent(encode(pts))})`);
      }
    }
  }

  const token = requireMapboxToken();
  const overlayStr = overlays.length ? `${overlays.join(',')}/` : '';
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlayStr}${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  const baseMap = await fetchMapboxStatic(url, 30000);

  const circles = buildCircles(points, centerLat, centerLon, zoom, WIDTH, HEIGHT, radiusForCount);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${circles.join('\n')}</svg>`;

  const composites = [{ input: Buffer.from(svg), top: 0, left: 0 }];
  if (kind === 'train' && trainLines && lineColors) {
    const insetBuf = await renderLoopInset({ points, trainLines, lineColors });
    composites.push({
      input: insetBuf,
      top: HEIGHT - LOOP_INSET_SIZE - LOOP_INSET_MARGIN,
      left: LOOP_INSET_MARGIN,
    });
  }

  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { renderHeatmap, radiusForCount, CHICAGO_BBOX, LOOP_BBOX };
