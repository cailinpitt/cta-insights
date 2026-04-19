const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { fitZoom } = require('../../shared/projection');
const {
  STYLE, WIDTH, HEIGHT,
  requireMapboxToken, fetchMapboxStatic,
} = require('../common');

// Chicago Loop elevated tracks bbox (Lake/Van Buren/Wells/Wabash) with a few
// blocks of padding so surrounding stations fit.
const LOOP_BBOX = {
  minLat: 41.874,
  maxLat: 41.891,
  minLon: -87.638,
  maxLon: -87.622,
};
const LOOP_INSET_SIZE = 400;
const LOOP_INSET_MARGIN = 20;

async function renderLoopInset(trains, lineColors, trainLines) {
  const inBbox = (lat, lon) =>
    lat >= LOOP_BBOX.minLat && lat <= LOOP_BBOX.maxLat &&
    lon >= LOOP_BBOX.minLon && lon <= LOOP_BBOX.maxLon;
  const loopTrains = trains.filter((t) => inBbox(t.lat, t.lon));

  const overlays = [];
  if (trainLines) {
    // Brown/Green/Orange/Purple/Pink share the Loop elevated rectangle on the
    // exact same tracks. Drawn at equal width, the last one wins and the others
    // vanish. Stack them widest-first so each appears as a concentric band on
    // the shared segment. Non-sharing lines (blue/red/yellow) stay thin.
    const RING_ORDER = ['brn', 'g', 'org', 'p', 'pink'];
    const ringIdx = Object.fromEntries(RING_ORDER.map((l, i) => [l, i]));
    const entries = Object.entries(trainLines)
      .sort(([a], [b]) => (ringIdx[a] ?? -1) - (ringIdx[b] ?? -1));
    for (const [line, segments] of entries) {
      const color = lineColors[line] || 'ffffff';
      const width = line in ringIdx
        ? 4 + (RING_ORDER.length - 1 - ringIdx[line]) * 2
        : 4;
      for (const points of segments) {
        if (!points || points.length < 2) continue;
        overlays.push(`path-${width}+${color}-0.85(${encodeURIComponent(encode(points))})`);
      }
    }
  }
  for (const t of loopTrains) {
    const color = lineColors[t.line] || 'ffffff';
    overlays.push(`pin-s+${color}(${t.lon.toFixed(4)},${t.lat.toFixed(4)})`);
  }

  const centerLat = (LOOP_BBOX.minLat + LOOP_BBOX.maxLat) / 2;
  const centerLon = (LOOP_BBOX.minLon + LOOP_BBOX.maxLon) / 2;
  const rawZoom = fitZoom(LOOP_BBOX, LOOP_INSET_SIZE, LOOP_INSET_SIZE, 20);
  const zoom = Math.max(13, Math.min(17, Math.floor(rawZoom)));

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${LOOP_INSET_SIZE}x${LOOP_INSET_SIZE}@2x?access_token=${token}`;
  const data = await fetchMapboxStatic(url);

  const frameSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LOOP_INSET_SIZE}" height="${LOOP_INSET_SIZE}">
    <rect x="2" y="2" width="${LOOP_INSET_SIZE - 4}" height="${LOOP_INSET_SIZE - 4}" fill="none" stroke="#fff" stroke-width="4"/>
    <rect x="10" y="10" width="104" height="32" fill="#000" fill-opacity="0.8" rx="3"/>
    <text x="62" y="32" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="600">The Loop</text>
  </svg>`;

  return sharp(data)
    .resize(LOOP_INSET_SIZE, LOOP_INSET_SIZE)
    .composite([{ input: Buffer.from(frameSvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

async function renderSnapshot(trains, lineColors, trainLines = null) {
  const overlays = [];

  if (trainLines) {
    for (const [line, segments] of Object.entries(trainLines)) {
      const color = lineColors[line] || 'ffffff';
      for (const points of segments) {
        if (!points || points.length < 2) continue;
        const encoded = encodeURIComponent(encode(points));
        overlays.push(`path-2+${color}-0.55(${encoded})`);
      }
    }
  }

  // Colored pin per train. Stations are intentionally omitted from the main
  // overlays — at system scale they blow the Mapbox URL limit. The inset below
  // shows stations zoomed in on the Loop where density matters.
  for (const t of trains) {
    const color = lineColors[t.line] || 'ffffff';
    overlays.push(`pin-s+${color}(${t.lon.toFixed(4)},${t.lat.toFixed(4)})`);
  }

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;
  const data = await fetchMapboxStatic(url);

  const composites = [];
  if (trainLines) {
    const insetBuf = await renderLoopInset(trains, lineColors, trainLines);
    composites.push({
      input: insetBuf,
      top: HEIGHT - LOOP_INSET_SIZE - LOOP_INSET_MARGIN,
      left: LOOP_INSET_MARGIN,
    });
  }

  return sharp(data)
    .resize(WIDTH, HEIGHT)
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { renderSnapshot, renderLoopInset };
