const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { fitZoom, project } = require('../../shared/projection');
const { STYLE, WIDTH, HEIGHT, requireMapboxToken, fetchMapboxStatic } = require('../common');

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

// Train marker geometry — matches Mapbox `pin-s` visual weight so still and
// video frames look similar to the legacy auto-framed snapshot.
const PIN_RADIUS_MAIN = 8;
const PIN_RADIUS_INSET = 7;

function bboxFromTrainLines(trainLines) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const segments of Object.values(trainLines)) {
    for (const points of segments) {
      for (const [lat, lon] of points) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
  }
  return { minLat, maxLat, minLon, maxLon };
}

function computeSnapshotView(trainLines) {
  // Fixed framing across every frame of a timelapse — `auto` would change the
  // viewport when trains enter/leave the periphery, breaking the illusion.
  const bbox = bboxFromTrainLines(trainLines);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 60);
  const zoom = Math.max(8, Math.min(13, Math.floor(rawZoom * 100) / 100));
  return { centerLat, centerLon, zoom, width: WIDTH, height: HEIGHT };
}

function computeLoopInsetView() {
  const centerLat = (LOOP_BBOX.minLat + LOOP_BBOX.maxLat) / 2;
  const centerLon = (LOOP_BBOX.minLon + LOOP_BBOX.maxLon) / 2;
  const rawZoom = fitZoom(LOOP_BBOX, LOOP_INSET_SIZE, LOOP_INSET_SIZE, 20);
  const zoom = Math.max(13, Math.min(17, Math.floor(rawZoom)));
  return {
    centerLat,
    centerLon,
    zoom,
    width: LOOP_INSET_SIZE,
    height: LOOP_INSET_SIZE,
    bbox: LOOP_BBOX,
  };
}

function buildLineOverlays(trainLines, lineColors, opts = {}) {
  const overlays = [];
  if (!trainLines) return overlays;
  if (opts.loopRings) {
    // Brown/Green/Orange/Purple/Pink share the Loop elevated rectangle on the
    // exact same tracks. Stack them widest-first so each appears as a
    // concentric band on the shared segment.
    const RING_ORDER = ['brn', 'g', 'org', 'p', 'pink'];
    const ringIdx = Object.fromEntries(RING_ORDER.map((l, i) => [l, i]));
    const entries = Object.entries(trainLines).sort(
      ([a], [b]) => (ringIdx[a] ?? -1) - (ringIdx[b] ?? -1),
    );
    for (const [line, segments] of entries) {
      const color = lineColors[line] || 'ffffff';
      const width = line in ringIdx ? 4 + (RING_ORDER.length - 1 - ringIdx[line]) * 2 : 4;
      for (const points of segments) {
        if (!points || points.length < 2) continue;
        overlays.push(`path-${width}+${color}-0.85(${encodeURIComponent(encode(points))})`);
      }
    }
  } else {
    for (const [line, segments] of Object.entries(trainLines)) {
      const color = lineColors[line] || 'ffffff';
      for (const points of segments) {
        if (!points || points.length < 2) continue;
        overlays.push(`path-2+${color}-0.55(${encodeURIComponent(encode(points))})`);
      }
    }
  }
  return overlays;
}

async function fetchMainBase(view, lineColors, trainLines) {
  const overlays = buildLineOverlays(trainLines, lineColors);
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${view.width}x${view.height}@2x?access_token=${token}`;
  return fetchMapboxStatic(url);
}

async function fetchLoopInsetBase(view, lineColors, trainLines) {
  const overlays = buildLineOverlays(trainLines, lineColors, { loopRings: true });
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${view.width}x${view.height}@2x?access_token=${token}`;
  const data = await fetchMapboxStatic(url);

  // Bake the frame chrome and "The Loop" title in once — these never change
  // between frames, so doing it per-frame would be wasted work.
  const frameSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}">
    <rect x="2" y="2" width="${view.width - 4}" height="${view.height - 4}" fill="none" stroke="#fff" stroke-width="4"/>
    <rect x="10" y="10" width="104" height="32" fill="#000" fill-opacity="0.8" rx="3"/>
    <text x="62" y="32" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="600">The Loop</text>
  </svg>`;
  return sharp(data)
    .resize(view.width, view.height)
    .composite([{ input: Buffer.from(frameSvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

async function fetchSnapshotBaseLayer(view, insetView, lineColors, trainLines) {
  const [mainBase, insetBase] = await Promise.all([
    fetchMainBase(view, lineColors, trainLines),
    fetchLoopInsetBase(insetView, lineColors, trainLines),
  ]);
  return { mainBase, insetBase, view, insetView };
}

function buildPinSvg(width, height, trainPixels, radius) {
  const circles = trainPixels
    .map(
      ({ x, y, color }) =>
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}" fill="#${color}" stroke="#fff" stroke-width="2"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${circles}</svg>`;
}

function projectTrains(trains, view, lineColors) {
  const out = [];
  for (const t of trains) {
    const { x, y } = project(
      t.lat,
      t.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      view.width,
      view.height,
    );
    if (x < -10 || x > view.width + 10 || y < -10 || y > view.height + 10) continue;
    out.push({ x, y, color: lineColors[t.line] || 'ffffff' });
  }
  return out;
}

async function renderSnapshotFrame(layers, lineColors, trains) {
  const { mainBase, insetBase, view, insetView } = layers;

  const mainPixels = projectTrains(trains, view, lineColors);
  const mainSvg = buildPinSvg(view.width, view.height, mainPixels, PIN_RADIUS_MAIN);

  // Don't pre-filter by LOOP_BBOX — the inset map area extends slightly past
  // the bbox (zoom is floored), so pre-filtering makes trains pop in/out
  // mid-view. Let projectTrains' pixel-bounds clip handle visibility instead.
  const insetPixels = projectTrains(trains, insetView, lineColors);
  const insetSvg = buildPinSvg(insetView.width, insetView.height, insetPixels, PIN_RADIUS_INSET);

  const insetWithPins = await sharp(insetBase)
    .composite([{ input: Buffer.from(insetSvg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  return sharp(mainBase)
    .resize(view.width, view.height)
    .composite([
      { input: Buffer.from(mainSvg), top: 0, left: 0 },
      {
        input: insetWithPins,
        top: view.height - insetView.height - LOOP_INSET_MARGIN,
        left: LOOP_INSET_MARGIN,
      },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function renderSnapshot(trains, lineColors, trainLines = null) {
  // Legacy path used by the still-image snapshot. Uses Mapbox `auto` framing
  // and lets Mapbox draw the pins, matching the original look.
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

  // Stations are intentionally omitted from the main overlays — at system
  // scale they blow the Mapbox URL limit. The inset shows stations zoomed in.
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

  return sharp(data).resize(WIDTH, HEIGHT).composite(composites).jpeg({ quality: 85 }).toBuffer();
}

async function renderLoopInset(trains, lineColors, trainLines) {
  const inBbox = (lat, lon) =>
    lat >= LOOP_BBOX.minLat &&
    lat <= LOOP_BBOX.maxLat &&
    lon >= LOOP_BBOX.minLon &&
    lon <= LOOP_BBOX.maxLon;
  const loopTrains = trains.filter((t) => inBbox(t.lat, t.lon));

  const overlays = buildLineOverlays(trainLines, lineColors, { loopRings: true });
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

module.exports = {
  renderSnapshot,
  renderLoopInset,
  computeSnapshotView,
  computeLoopInsetView,
  fetchSnapshotBaseLayer,
  renderSnapshotFrame,
};
