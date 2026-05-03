const sharp = require('sharp');
const { encode } = require('../shared/polyline');
const { fitZoom, project } = require('../shared/projection');
const { STYLE, WIDTH, HEIGHT, requireMapboxToken, fetchMapboxStatic } = require('./common');

// Sized to contain the full CTA rail system so it sits centered in the
// frame: Linden (Purple, ~42.073) and Dempster-Skokie (Yellow, ~42.038)
// at the north, 95th/Dan Ryan (~41.722) at the south, Forest Park
// (~41.875, -87.817) and O'Hare (~41.978, -87.904) at the west, and the
// lakefront at the east. Earlier bbox stopped at 42.03, which clipped
// the Yellow and Purple termini at the top of the image.
const CHICAGO_BBOX = {
  minLat: 41.69,
  maxLat: 42.1,
  minLon: -87.92,
  maxLon: -87.52,
};

// Wider than the Loop proper (Wabash↔Wells, Lake↔Van Buren) — bus bunching
// hotspots cluster heavily in River North and the West Loop, both just
// outside the strict CTA Loop. Train heatmap also benefits from the wider
// view since five lines feed in from beyond the Loop rectangle.
const LOOP_BBOX = {
  minLat: 41.867, // Roosevelt Rd
  maxLat: 41.9, // Chicago Ave
  minLon: -87.658, // Halsted (West Loop)
  maxLon: -87.617, // Lake Shore Dr
};
const LOOP_INSET_SIZE = 400;
const LOOP_INSET_MARGIN = 20;

const CIRCLE_COLOR = '#ff2a6d';
const CIRCLE_STROKE = '#fff';
// Log scaling so 10 incidents → ~3× a 1-incident spot, not 10×.
function radiusForCount(count) {
  return Math.round(12 + 14 * Math.log2(count + 1));
}

// Greedy pixel-distance merge: stop names that are geographically close (a
// few intersections apart) project to overlapping circles at citywide zoom,
// hiding smaller bubbles behind big ones. Merge any pair whose centers are
// closer than the larger of the two radii — keep merging until stable.
function clusterByPixels(points, centerLat, centerLon, zoom, width, height, radiusFn) {
  const items = points.map((p) => {
    const { x, y } = project(p.lat, p.lon, centerLat, centerLon, zoom, width, height);
    return {
      x,
      y,
      count: p.count,
      r: radiusFn(p.count),
      // Optional group tag — when set, clustering refuses merges across
      // groups so an inset-bbox bubble doesn't absorb non-inset stations.
      group: p.group,
      // Keep the dominant label so the alt text from the post still maps to a
      // recognizable intersection.
      labels: [{ label: p.label, count: p.count }],
    };
  });

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.group && b.group && a.group !== b.group) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < (a.r + b.r) * 0.5) {
          const newCount = a.count + b.count;
          // Weighted centroid keeps the merged bubble visually anchored on
          // the heavier of the two stops.
          const wx = (a.x * a.count + b.x * b.count) / newCount;
          const wy = (a.y * a.count + b.y * b.count) / newCount;
          a.x = wx;
          a.y = wy;
          a.count = newCount;
          a.r = radiusFn(newCount);
          a.labels = [...a.labels, ...b.labels].sort((x, y) => y.count - x.count);
          items.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return items;
}

function renderClusters(clusters) {
  const sorted = [...clusters].sort((a, b) => a.count - b.count);
  return sorted.map((c) => {
    const fontSize = Math.max(12, Math.round(c.r * 0.9));
    return [
      `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${c.r}" fill="${CIRCLE_COLOR}" fill-opacity="0.55" stroke="${CIRCLE_STROKE}" stroke-width="2"/>`,
      `<text x="${c.x.toFixed(1)}" y="${(c.y + fontSize / 3).toFixed(1)}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" stroke="#000" stroke-width="2" paint-order="stroke">${c.count}</text>`,
    ].join('');
  });
}

function legendSamples(maxCount) {
  if (maxCount <= 1) return [1];
  if (maxCount <= 5) return [1, maxCount];
  const mid = Math.max(3, Math.round(maxCount / 3));
  return [1, mid, maxCount];
}

// Sample-dot legend so the image is self-explanatory: counts are events per
// hotspot, sized log-proportionally. Returns { svg, width } so the caller can
// anchor it without overflowing the map. Samples include the largest cluster
// on this map so a "42" hotspot doesn't render bigger than any legend dot.
function buildLegend(maxCount) {
  const samples = legendSamples(maxCount);
  // Scaled-down radii — a 1:1 with map circles makes the legend dwarf small
  // hotspots; halving still preserves the relative scale.
  const legendR = (count) => Math.round(6 + 8 * Math.log2(count + 1));
  const radii = samples.map(legendR);
  const maxR = Math.max(...radii);
  const padX = 14;
  const padY = 12;
  const gap = 16;
  const titleH = 22;
  const innerW = radii.reduce((a, r) => a + 2 * r, 0) + gap * (samples.length - 1);
  const width = innerW + padX * 2;
  const height = titleH + padY + 2 * maxR + padY;
  const cy = titleH + padY + maxR;

  let cx = padX;
  const dots = [];
  for (let i = 0; i < samples.length; i++) {
    const r = radii[i];
    const dotCx = cx + r;
    dots.push(
      `<circle cx="${dotCx}" cy="${cy}" r="${r}" fill="${CIRCLE_COLOR}" fill-opacity="0.55" stroke="${CIRCLE_STROKE}" stroke-width="2"/>`,
      `<text x="${dotCx}" y="${cy + 5}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="700" stroke="#000" stroke-width="2" paint-order="stroke">${samples[i]}</text>`,
    );
    cx += 2 * r + gap;
  }

  const svg = `
    <rect x="0" y="0" width="${width}" height="${height}" rx="6" fill="#000" fill-opacity="0.7" stroke="#fff" stroke-width="1"/>
    <text x="${width / 2}" y="${padY + 14}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="600">Events per hotspot</text>
    ${dots.join('\n')}`;
  return { svg, width, height };
}

async function renderLoopInset({ points, kind, trainLines, lineColors }) {
  const inBbox = (lat, lon) =>
    lat >= LOOP_BBOX.minLat &&
    lat <= LOOP_BBOX.maxLat &&
    lon >= LOOP_BBOX.minLon &&
    lon <= LOOP_BBOX.maxLon;
  const loopPoints = points.filter((p) => inBbox(p.lat, p.lon));

  const overlays = [];
  if (kind === 'train' && trainLines && lineColors) {
    // Concentric rings so all five Loop-sharing lines stay visible.
    const RING_ORDER = ['brn', 'g', 'org', 'p', 'pink'];
    const ringIdx = Object.fromEntries(RING_ORDER.map((l, i) => [l, i]));
    const entries = Object.entries(trainLines).sort(
      ([a], [b]) => (ringIdx[a] ?? -1) - (ringIdx[b] ?? -1),
    );
    for (const [line, segments] of entries) {
      const color = lineColors[line] || 'ffffff';
      const width = line in ringIdx ? 4 + (RING_ORDER.length - 1 - ringIdx[line]) * 2 : 4;
      for (const pts of segments) {
        if (!pts || pts.length < 2) continue;
        overlays.push(`path-${width}+${color}-0.85(${encodeURIComponent(encode(pts))})`);
      }
    }
  }

  const centerLat = (LOOP_BBOX.minLat + LOOP_BBOX.maxLat) / 2;
  const centerLon = (LOOP_BBOX.minLon + LOOP_BBOX.maxLon) / 2;
  // Use the raw fit zoom (capped) instead of floor — flooring zoomed in
  // past the bbox, pushing south-edge Loop stations (Roosevelt, Jackson,
  // etc.) off the bottom of the 400×400 canvas. Their clusters then
  // failed to render even though they were correctly grouped, making the
  // inset's visible total smaller than the main map's downtown bubble.
  const rawZoom = fitZoom(LOOP_BBOX, LOOP_INSET_SIZE, LOOP_INSET_SIZE, 20);
  const zoom = Math.max(13, Math.min(17, rawZoom));

  const token = requireMapboxToken();
  const overlayPart = overlays.length ? `${overlays.join(',')}/` : '';
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlayPart}${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${LOOP_INSET_SIZE}x${LOOP_INSET_SIZE}@2x?access_token=${token}`;
  const baseMap = await fetchMapboxStatic(url);

  // Smaller radius so a count-7 dot doesn't swallow the Loop rectangle.
  const insetRadius = (count) => Math.round(8 + 8 * Math.log2(count + 1));
  const clusters = clusterByPixels(
    loopPoints,
    centerLat,
    centerLon,
    zoom,
    LOOP_INSET_SIZE,
    LOOP_INSET_SIZE,
    insetRadius,
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LOOP_INSET_SIZE}" height="${LOOP_INSET_SIZE}">
    ${renderClusters(clusters).join('\n')}
    <rect x="2" y="2" width="${LOOP_INSET_SIZE - 4}" height="${LOOP_INSET_SIZE - 4}" fill="none" stroke="#fff" stroke-width="4"/>
    <rect x="10" y="10" width="120" height="32" fill="#000" fill-opacity="0.8" rx="3"/>
    <text x="70" y="32" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="600">Downtown</text>
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

  // Tag each point as Loop or non-Loop so clustering can refuse cross-
  // boundary merges. Without this, a Loop station and a near-Loop station
  // (Belmont, Fullerton) can merge at citywide zoom and the resulting
  // bubble's count exceeds what the Loop inset shows below — confusing
  // because the inset only breaks down strict-Loop stations.
  const inLoop = (lat, lon) =>
    lat >= LOOP_BBOX.minLat &&
    lat <= LOOP_BBOX.maxLat &&
    lon >= LOOP_BBOX.minLon &&
    lon <= LOOP_BBOX.maxLon;
  const taggedPoints = points.map((p) => ({ ...p, group: inLoop(p.lat, p.lon) ? 'loop' : 'rest' }));
  const clusters = clusterByPixels(
    taggedPoints,
    centerLat,
    centerLon,
    zoom,
    WIDTH,
    HEIGHT,
    radiusForCount,
  );
  // Loop inset sits bottom-left, so anchor the legend top-right where it's
  // unlikely to collide with hotspots (Chicago's east edge is the lakefront).
  const maxClusterCount = clusters.reduce((m, c) => Math.max(m, c.count), 0);
  const legend = buildLegend(maxClusterCount);
  const legendX = WIDTH - legend.width - 20;
  const legendY = 20;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${renderClusters(clusters).join('\n')}<g transform="translate(${legendX}, ${legendY})">${legend.svg}</g></svg>`;

  const composites = [{ input: Buffer.from(svg), top: 0, left: 0 }];
  const insetBuf = await renderLoopInset({ points, kind, trainLines, lineColors });
  composites.push({
    input: insetBuf,
    top: HEIGHT - LOOP_INSET_SIZE - LOOP_INSET_MARGIN,
    left: LOOP_INSET_MARGIN,
  });

  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { renderHeatmap, radiusForCount, CHICAGO_BBOX, LOOP_BBOX };
