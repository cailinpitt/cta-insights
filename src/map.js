const axios = require('axios');
const sharp = require('sharp');
const { encode } = require('./polyline');
const { cumulativeDistances, haversineFt, bearing } = require('./geo');
const { buildLinePolyline, snapToLine, offsetPolyline } = require('./trainSpeedmap');
const { colorForBusSpeed, colorForTrainSpeed } = require('./speedmap');
const { fitZoom, project } = require('./projection');

const STYLE = 'mapbox/dark-v11';
const WIDTH = 1200;
const HEIGHT = 1200;

// Direction-of-travel arrow rendered as an SVG path (not a Unicode glyph) so
// the result is identical across hosts. librsvg's font fallback differs
// between macOS (Helvetica) and Ubuntu (DejaVu), which warped the arrow shape.
// Two strokes — chevron head + straight shaft — to match the Helvetica ↑ look:
// thin shaft, open chevron, white-on-black outline.
const ARROW_PATH_D = 'M -40,-30 L 0,-75 L 40,-30 M 0,-75 L 0,75';

function buildDirectionArrow(cx, cy, bearingDeg) {
  const rotation = Math.round(bearingDeg / 45) * 45;
  const transform = `translate(${cx} ${cy}) rotate(${rotation})`;
  return [
    `<path d="${ARROW_PATH_D}" fill="none" stroke="#000" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" transform="${transform}"/>`,
    `<path d="${ARROW_PATH_D}" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" transform="${transform}"/>`,
  ].join('');
}

// Two-tone route line: dark halo + bright core makes the route pop against the basemap.
const ROUTE_HALO_COLOR = '000';
const ROUTE_HALO_STROKE = 14;
const ROUTE_CORE_COLOR = '00d8ff';
const ROUTE_CORE_STROKE = 8;

const BUS_COLOR = 'ff2a6d';         // hot pink/red reads well on dark
const CONTEXT_PAD_FT = 1500;        // feet of route context on each side of the bunch

// Twemoji 🚌 (U+1F68C) paths, 36x36 viewBox. Inlined so sharp/librsvg can render
// the emoji without needing a color emoji font on the host system.
const TWEMOJI_BUS_INNER = '<path fill="#808285" d="M0 21v7c0 1.657 1.343 3 3 3h30c1.657 0 3-1.343 3-3v-7H0z"/><path fill="#CCD6DD" d="M36 22v-9c0-1.657-3.343-3-5-3H11c-8 0-11 2.343-11 4v8h36z"/><path fill="#939598" d="M0 22h36v3H0z"/><path fill="#BCBEC0" d="M7 25c-3.063 0-5.586 2.298-5.95 5.263.526.453 1.202.737 1.95.737h10c0-3.313-2.686-6-6-6zm27.95 5.263C34.586 27.298 32.063 25 29 25c-3.313 0-6 2.687-6 6h10c.749 0 1.425-.284 1.95-.737z"/><circle cx="7" cy="31" r="4"/><circle fill="#99AAB5" cx="7" cy="31" r="2"/><circle cx="29" cy="31" r="4"/><circle fill="#99AAB5" cx="29" cy="31" r="2"/><path fill="#F4900C" d="M0 25h1v2H0zm35-2h1v2h-1z"/><path fill="#58595B" d="M1 13h35v10H1z"/><path fill="#292F33" d="M2 13H.342C.11 13.344 0 13.685 0 14v11h2c1.104 0 2-.896 2-2v-8c0-1.104-.896-2-2-2z"/><path fill="#55ACEE" d="M31 20c0 .553-.447 1-1 1H7c-.552 0-1-.447-1-1v-4c0-.552.448-1 1-1h23c.553 0 1 .448 1 1v4z"/><path fill="#FFAC33" d="M35 19h1v2h-1z"/><path fill="#55ACEE" d="M1 15H0v8h1c.552 0 1-.447 1-1v-6c0-.552-.448-1-1-1z"/>';

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

  // For each vehicle, find the pattern point geographically closest to it,
  // and take that point's cumulative distance as the vehicle's position along
  // the line. Then slice the polyline to [min - pad, max + pad].
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

async function renderBunchingMap(bunch, pattern) {
  // Slice still drives zoom/bbox (so framing is unchanged), but we encode the
  // full pattern for the drawn polyline. That way the route line extends off
  // the edges of the image instead of terminating at the slice boundary.
  const slice = slicePatternAroundBunch(pattern, bunch);
  const polyline = encode(pattern.points.map((p) => [p.lat, p.lon]));

  const overlays = [];
  // Draw halo first, then core, so core renders on top. Pins render on top of both.
  const encoded = encodeURIComponent(polyline);
  overlays.push(`path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`);
  overlays.push(`path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`);
  // Markers are drawn as a custom SVG composite after fetching the base map, so
  // we can make them larger than Mapbox's pin-l limit.

  // Compute explicit center/zoom so we can project bus positions for SVG arrows.
  const allLats = [...slice.map((p) => p.lat), ...bunch.vehicles.map((v) => v.lat)];
  const allLons = [...slice.map((p) => p.lon), ...bunch.vehicles.map((v) => v.lon)];
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

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;

  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });

  // Compute a single route-wide direction bearing from the slice endpoints.
  // Averaging over the whole slice (~3000 ft) avoids a short orthogonal
  // waypoint jog in the CTA pattern dominating the arrow, which previously
  // produced 90°-off arrows on otherwise straight streets.
  const slicePoints = slice.map((p) => ({ lat: p.lat, lon: p.lon }));
  function routeDirectionBearing(headingSample) {
    if (slicePoints.length < 2) return headingSample;
    const fwd = bearing(slicePoints[0], slicePoints[slicePoints.length - 1]);
    const rev = (fwd + 180) % 360;
    const diffFwd = Math.abs(((headingSample - fwd + 540) % 360) - 180);
    const diffRev = Math.abs(((headingSample - rev + 540) % 360) - 180);
    return diffFwd <= diffRev ? fwd : rev;
  }

  // Custom bus markers: larger than Mapbox pin-l, drawn via SVG composite.
  // Uses the Twemoji bus glyph (36x36 viewBox) so the emoji renders via librsvg
  // without relying on system emoji fonts, which sharp's text pipeline doesn't
  // reliably support across platforms.
  const BUS_MARKER_RADIUS = 34;
  const markerElements = bunch.vehicles.map((v) => {
    const { x, y } = project(v.lat, v.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
    const iconSize = BUS_MARKER_RADIUS * 1.6;
    const iconX = x - iconSize / 2;
    const iconY = y - iconSize / 2;
    return [
      `<circle cx="${x}" cy="${y}" r="${BUS_MARKER_RADIUS}" fill="#${BUS_COLOR}" stroke="#fff" stroke-width="4"/>`,
      `<svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 36 36">${TWEMOJI_BUS_INNER}</svg>`,
    ].join('');
  });

  // Big direction-of-travel arrow anchored in the top-right corner so it reads
  // as a route-wide indicator rather than being tied to a specific bus.
  const leadBus = bunch.vehicles.reduce((a, b) => (b.pdist > a.pdist ? b : a), bunch.vehicles[0]);
  const bearingDeg = routeDirectionBearing(leadBus.heading);
  const arrowElements = [buildDirectionArrow(WIDTH - 220, 180, bearingDeg)];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${markerElements.join('\n')}${arrowElements.join('\n')}</svg>`;

  // Bluesky image limit is 1MB; composite arrows then convert to JPEG.
  return sharp(data)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

const SPEEDMAP_SEGMENT_STROKE = 8;
const SPEEDMAP_HALO_STROKE = 12;

/**
 * Slice pattern points into N ordered groups by cumulative distance along the line.
 * Each slice is anchored by interpolated start/end points at exact bin boundaries
 * so sparse stretches of the polyline still render as a colored segment.
 */
function slicePatternIntoSegments(pattern, numBins) {
  const points = pattern.points;
  const cum = cumulativeDistances(points);
  const total = cum[cum.length - 1];
  const segLen = total / numBins;

  function pointAt(targetDist) {
    if (targetDist <= cum[0]) return points[0];
    if (targetDist >= cum[cum.length - 1]) return points[points.length - 1];
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= targetDist) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    const t = span === 0 ? 0 : (targetDist - cum[lo]) / span;
    const a = points[lo];
    const b = points[hi];
    return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
  }

  const slices = Array.from({ length: numBins }, () => []);
  for (let i = 0; i < numBins; i++) {
    const startDist = i * segLen;
    const endDist = i === numBins - 1 ? total : (i + 1) * segLen;
    slices[i].push(pointAt(startDist));
    for (let j = 0; j < points.length; j++) {
      if (cum[j] > startDist && cum[j] < endDist) {
        slices[i].push(points[j]);
      }
    }
    slices[i].push(pointAt(endDist));
  }
  return slices;
}

async function renderSpeedmap(pattern, binSpeeds) {
  const slices = slicePatternIntoSegments(pattern, binSpeeds.length);

  // Full-route dark halo rendered first, then each colored segment layered on top.
  const fullEncoded = encodeURIComponent(encode(pattern.points.map((p) => [p.lat, p.lon])));
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const encoded = encodeURIComponent(encode(slices[i].map((p) => [p.lat, p.lon])));
    const color = colorForBusSpeed(binSpeeds[i]);
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=30`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

const SNAPSHOT_WIDTH = 1200;
const SNAPSHOT_HEIGHT = 1200;

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
    const RING_ORDER = ['brn', 'g', 'org', 'p', 'pink']; // drawn in this sequence, widest to narrowest
    const ringIdx = Object.fromEntries(RING_ORDER.map((l, i) => [l, i]));
    const entries = Object.entries(trainLines)
      .sort(([a], [b]) => (ringIdx[a] ?? -1) - (ringIdx[b] ?? -1));
    for (const [line, segments] of entries) {
      const color = lineColors[line] || 'ffffff';
      const width = line in ringIdx
        ? 4 + (RING_ORDER.length - 1 - ringIdx[line]) * 2 // 12, 10, 8, 6, 4
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

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${LOOP_INSET_SIZE}x${LOOP_INSET_SIZE}@2x?access_token=${token}`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });

  // Border around the inset + "The Loop" label so it reads as a separate view.
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

  // Subtle line polylines drawn first so they appear under everything else.
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

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${SNAPSHOT_WIDTH}x${SNAPSHOT_HEIGHT}@2x?access_token=${token}&padding=60`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });

  const composites = [];
  if (trainLines) {
    const insetBuf = await renderLoopInset(trains, lineColors, trainLines);
    composites.push({
      input: insetBuf,
      top: SNAPSHOT_HEIGHT - LOOP_INSET_SIZE - LOOP_INSET_MARGIN,
      left: LOOP_INSET_MARGIN,
    });
  }

  return sharp(data)
    .resize(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT)
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();
}

const TRAIN_BUNCH_NEAREST_STATIONS = 2; // how many stations to label
const TRAIN_BUNCH_BBOX_PADDING_DEG = 0.003; // ~300m — zoom out a little past the trains

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Train pin radius. Set well above Mapbox pin-s (stations) so trains read as
// the primary focal point. Halo/arrow offsets are derived from this.
const TRAIN_MARKER_RADIUS = 32;

// Twemoji 🚆 (U+1F686) paths, 36x36 viewBox. Inlined so librsvg can render
// the emoji without needing a color emoji font on the host system.
const TWEMOJI_TRAIN_INNER = '<path fill="#A7A9AC" d="M2 36h32L23 19H13z"/><path fill="#58595B" d="M5 36h26L21 19h-6z"/><path fill="#808285" d="M8 36h20l-9-17h-2z"/><path fill="#A7A9AC" d="M28 35c0 .553-.447 1-1 1H9c-.552 0-1-.447-1-1 0-.553.448-1 1-1h18c.553 0 1 .447 1 1zm-2-4c0 .553-.447 1-1 1H11c-.552 0-1-.447-1-1 0-.553.448-1 1-1h14c.553 0 1 .447 1 1z"/><path fill="#58595B" d="M27.076 25.3L23 19H13l-4.076 6.3c1.889 2.517 4.798 4.699 9.076 4.699 4.277 0 7.188-2.183 9.076-4.699z"/><path fill="#A7A9AC" d="M18 0C9 0 6 3 6 9v8c0 1.999 3 11 12 11s12-9.001 12-11V9c0-6-3-9-12-9z"/><path fill="#E6E7E8" d="M8 11C8 2 12.477 1 18 1s10 1 10 10c0 6-4.477 11-10 11-5.523-.001-10-5-10-11z"/><path fill="#FFAC33" d="M18 21.999c1.642 0 3.185-.45 4.553-1.228C21.77 19.729 20.03 19 18 19s-3.769.729-4.552 1.772c1.366.777 2.911 1.227 4.552 1.227z"/><path d="M19 4.997v4.965c3.488-.232 6-1.621 6-2.463V5.833c0-.791-3.692-.838-6-.836zm-2 0c-2.308-.002-6 .044-6 .836V7.5c0 .842 2.512 2.231 6 2.463V4.997z" fill="#55ACEE"/><path fill="#269" d="M6 10s0 3 4 9c0 0-4-2-4-6v-3zm24 0s0 3-4 9c0 0 4-2 4-6v-3z"/>';

function buildTrainOverlaySvg(stationsWithPixels, atStationPixels, trainPixels, lineColor, widthPx, heightPx) {
  const fontSize = 18;
  const labelHeight = fontSize + 8;
  const gap = 4; // minimum vertical gap between labels

  // Strip trailing line-only parentheticals ("Chicago (Red)" -> "Chicago") since
  // bunching maps show a single line. Branch/variant parens like
  // "(Blue - Forest Park Branch)" or "(Subway)" are preserved because they
  // still disambiguate stations on the same line.
  const LINE_ONLY_PARENS = /\s*\((?:Red|Blue|Green|Brown|Purple|Pink|Orange|Yellow|\/|\s)+\)\s*$/;

  // Compute initial label positions, then nudge overlapping ones apart.
  // If a train is sitting at the station, anchor the label to the train's
  // projected y (not the station's) so the label sits below the train marker
  // + halo even when the train is offset from the station centroid.
  const STATION_LABEL_OFFSET = 18;
  const TRAIN_HALO_EXTRA = 8;
  const LABEL_CLEAR_GAP = 10;
  const labels = stationsWithPixels.map(({ station, x, y, hasTrain, trainY }) => {
    const label = xmlEscape(station.name.replace(LINE_ONLY_PARENS, ''));
    const approxWidth = label.length * 10 + 16;
    const rectY = hasTrain
      ? trainY + TRAIN_MARKER_RADIUS + TRAIN_HALO_EXTRA + LABEL_CLEAR_GAP
      : y + STATION_LABEL_OFFSET;
    return { label, x, rectY, approxWidth };
  });

  labels.sort((a, b) => a.rectY - b.rectY);
  for (let i = 1; i < labels.length; i++) {
    const prev = labels[i - 1];
    const minY = prev.rectY + labelHeight + gap;
    if (labels[i].rectY < minY) {
      labels[i].rectY = minY;
    }
  }

  // White ring halo for trains sitting at a station. Sits just outside the
  // train marker so the train stays the focal point but is visually flagged.
  const halos = atStationPixels.map(({ x, y }) => {
    return `<circle cx="${x}" cy="${y}" r="${TRAIN_MARKER_RADIUS + 8}" fill="none" stroke="#fff" stroke-width="4"/>`;
  });

  // Custom train markers. Larger than Mapbox's pin-s station markers and
  // filled with the line color so bunching visually reads as that line.
  const iconSize = TRAIN_MARKER_RADIUS * 1.6;
  const trainMarkers = trainPixels.map(({ x, y }) => {
    const iconX = x - iconSize / 2;
    const iconY = y - iconSize / 2;
    return [
      `<circle cx="${x}" cy="${y}" r="${TRAIN_MARKER_RADIUS}" fill="#${lineColor}" stroke="#fff" stroke-width="4"/>`,
      `<svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 36 36">${TWEMOJI_TRAIN_INNER}</svg>`,
    ].join('');
  });

  // One big direction-of-travel arrow in the top-right corner, matching the
  // bus bunching map style. Both trains share trDr so any bearing works.
  const arrows = [];
  if (trainPixels.length > 0) {
    arrows.push(buildDirectionArrow(widthPx - 220, 180, trainPixels[0].bearingDeg));
  }

  const labelElements = labels.map(({ label, x, rectY, approxWidth }) => {
    const rectX = x - approxWidth / 2;
    const textX = x;
    const textY = rectY + fontSize + 2;
    return `
    <rect x="${rectX}" y="${rectY}" width="${approxWidth}" height="${labelHeight}" fill="#000" fill-opacity="0.8" rx="3"/>
    <text x="${textX}" y="${textY}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${label}</text>`;
  });

  const elements = [...halos, ...trainMarkers, ...arrows, ...labelElements].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">${elements}</svg>`;
}

async function renderTrainBunching(bunch, lineColors, trainLines, stations) {
  const color = lineColors[bunch.line] || 'ffffff';

  // Use along-track distance to pick stations that bracket the bunch —
  // one ahead of the leading train and one behind the trailing train.
  const { points: linePts, cumDist: lineCumDist } = buildLinePolyline(trainLines, bunch.line);
  const trainTrackDists = bunch.trains.map((t) => snapToLine(t.lat, t.lon, linePts, lineCumDist));
  const minTrainDist = Math.min(...trainTrackDists);
  const maxTrainDist = Math.max(...trainTrackDists);

  const onLineStations = (stations || []).filter((s) => s.lines?.includes(bunch.line));
  const stationsWithDist = onLineStations.map((s) => ({
    station: s,
    trackDist: snapToLine(s.lat, s.lon, linePts, lineCumDist),
  }));

  // Find the closest station behind the trailing train and ahead of the leading train.
  const behind = stationsWithDist
    .filter((s) => s.trackDist < minTrainDist)
    .sort((a, b) => b.trackDist - a.trackDist);
  const ahead = stationsWithDist
    .filter((s) => s.trackDist > maxTrainDist)
    .sort((a, b) => a.trackDist - b.trackDist);
  const between = stationsWithDist
    .filter((s) => s.trackDist >= minTrainDist && s.trackDist <= maxTrainDist)
    .sort((a, b) => a.trackDist - b.trackDist);

  const nearestStations = [];
  if (behind.length > 0) nearestStations.push(behind[0].station);
  if (between.length > 0) nearestStations.push(between[0].station);
  if (ahead.length > 0) nearestStations.push(ahead[0].station);
  // If we didn't get 3, fill from the closest by haversine as fallback.
  if (nearestStations.length < 2) {
    const bunchLat = bunch.trains.reduce((a, t) => a + t.lat, 0) / bunch.trains.length;
    const bunchLon = bunch.trains.reduce((a, t) => a + t.lon, 0) / bunch.trains.length;
    const already = new Set(nearestStations.map((s) => s.name));
    const fallback = onLineStations
      .filter((s) => !already.has(s.name))
      .sort((a, b) => haversineFt({ lat: bunchLat, lon: bunchLon }, a) - haversineFt({ lat: bunchLat, lon: bunchLon }, b));
    for (const s of fallback) {
      if (nearestStations.length >= 2) break;
      nearestStations.push(s);
    }
  }

  // Build bbox to include the bunched trains AND the chosen stations — that
  // way every pin and label we intend to render is inside the rendered viewport.
  const allLats = [...bunch.trains.map((t) => t.lat), ...nearestStations.map((s) => s.lat)];
  const allLons = [...bunch.trains.map((t) => t.lon), ...nearestStations.map((s) => s.lon)];
  const bbox = {
    minLat: Math.min(...allLats) - TRAIN_BUNCH_BBOX_PADDING_DEG,
    maxLat: Math.max(...allLats) + TRAIN_BUNCH_BBOX_PADDING_DEG,
    minLon: Math.min(...allLons) - TRAIN_BUNCH_BBOX_PADDING_DEG,
    maxLon: Math.max(...allLons) + TRAIN_BUNCH_BBOX_PADDING_DEG,
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  // Use integer zoom. Mapbox may round or snap fractional zooms during render,
  // which would decouple our projection math from the actual image. Ceil (not
  // floor) so we zoom in tighter around the bunch — otherwise far-off stations
  // get pulled in and the label stack gets cluttered.
  const rawZoom = fitZoom(bbox, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT, 60);
  const zoom = Math.max(10, Math.min(17, Math.ceil(rawZoom)));

  // Draw the full line segments so the route runs off the edges of the frame
  // instead of terminating just beyond the trains. The bbox/zoom above still
  // drives framing, so the visible portion is unchanged.
  const overlays = [];
  const lineSegments = trainLines?.[bunch.line] || [];
  for (const seg of lineSegments) {
    if (seg.length < 2) continue;
    overlays.push(`path-7+${color}-0.7(${encodeURIComponent(encode(seg))})`);
  }

  // Include every on-line station whose pixel position lands inside the image,
  // rather than just the stations bracketing the bunch. The bracket list above
  // still drives the bbox, so framing is unchanged. For stations where a
  // bunched train is sitting, record that train's projected y so the label
  // layer can anchor the label below the *train marker*, not the station —
  // the two can be a few hundred feet apart when the train hasn't quite
  // reached the platform centroid, and the station-anchored label ends up
  // overlapping the train pin.
  const visibleStations = onLineStations
    .map((s) => {
      const pixels = project(s.lat, s.lon, centerLat, centerLon, zoom, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
      const nearbyTrain = bunch.trains.find((t) => haversineFt({ lat: s.lat, lon: s.lon }, t) < 500);
      const trainY = nearbyTrain
        ? project(nearbyTrain.lat, nearbyTrain.lon, centerLat, centerLon, zoom, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT).y
        : null;
      return { station: s, ...pixels, hasTrain: !!nearbyTrain, trainY };
    })
    .filter(({ x, y }) => x >= 0 && x <= SNAPSHOT_WIDTH && y >= 0 && y <= SNAPSHOT_HEIGHT);

  // Track which trains are at a station for the SVG halo layer.
  const trainAtStation = new Set();
  for (const { station: s, hasTrain } of visibleStations) {
    if (!hasTrain) {
      overlays.push(`pin-s+ffffff(${s.lon.toFixed(5)},${s.lat.toFixed(5)})`);
    } else {
      bunch.trains.forEach((t) => {
        if (haversineFt({ lat: s.lat, lon: s.lon }, t) < 500) trainAtStation.add(t.rn);
      });
    }
  }
  // Train markers are drawn via SVG composite (see buildTrainOverlaySvg) so
  // they can be sized larger than Mapbox's pin-l.

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${SNAPSHOT_WIDTH}x${SNAPSHOT_HEIGHT}@2x?access_token=${token}`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });

  // Compute track bearing at each train's position by snapping to the polyline.
  const allSegPoints = lineSegments.flatMap((seg) =>
    seg.map(([lat, lon]) => ({ lat, lon }))
  );

  // Find the nearest polyline segment to a point using perpendicular distance.
  function nearestSegment(pt) {
    let bestDist = Infinity;
    let bestA = null;
    let bestB = null;
    for (let i = 0; i < allSegPoints.length - 1; i++) {
      const a = allSegPoints[i];
      const b = allSegPoints[i + 1];
      // Project pt onto segment a–b (in lat/lon space, fine for short segments).
      const dx = b.lon - a.lon;
      const dy = b.lat - a.lat;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) t = Math.max(0, Math.min(1, ((pt.lon - a.lon) * dx + (pt.lat - a.lat) * dy) / lenSq));
      const proj = { lat: a.lat + t * dy, lon: a.lon + t * dx };
      const d = haversineFt(pt, proj);
      if (d < bestDist) { bestDist = d; bestA = a; bestB = b; }
    }
    return { from: bestA, to: bestB };
  }

  function trackBearingAt(train) {
    const { from, to } = nearestSegment(train);
    const fwd = bearing(from, to);
    // If the train heading is closer to the reverse direction, flip it.
    const rev = (fwd + 180) % 360;
    const diffFwd = Math.abs(((train.heading - fwd + 540) % 360) - 180);
    const diffRev = Math.abs(((train.heading - rev + 540) % 360) - 180);
    return diffFwd <= diffRev ? fwd : rev;
  }

  // Composite station name labels, at-station halos, and direction arrows.
  const stationsWithPixels = visibleStations;
  const atStationPixels = bunch.trains
    .filter((t) => trainAtStation.has(t.rn))
    .map((t) => project(t.lat, t.lon, centerLat, centerLon, zoom, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT));
  const trainPixels = bunch.trains.map((t) => ({
    ...project(t.lat, t.lon, centerLat, centerLon, zoom, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT),
    bearingDeg: trackBearingAt(t),
  }));
  const svg = buildTrainOverlaySvg(stationsWithPixels, atStationPixels, trainPixels, color, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);

  return sharp(data)
    .resize(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Slice a trainLines polyline (array of [lat, lon]) into N ordered groups by
 * cumulative distance. Each slice is anchored by interpolated start/end points
 * at exact bin boundaries, so even sparse polylines (e.g. the Red Line, with
 * only 80 vertices across 22 mi) produce a renderable segment per bin instead
 * of dropping bins where vertices happen to be absent.
 */
function sliceLineIntoSegments(linePoints, cumDist, numBins) {
  const total = cumDist[cumDist.length - 1];
  const segLen = total / numBins;

  // Linearly interpolate a [lat, lon] point at a given cumulative distance
  // along the polyline.
  function pointAt(targetDist) {
    if (targetDist <= cumDist[0]) return linePoints[0];
    if (targetDist >= cumDist[cumDist.length - 1]) return linePoints[linePoints.length - 1];
    let lo = 0;
    let hi = cumDist.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cumDist[mid] <= targetDist) lo = mid;
      else hi = mid;
    }
    const span = cumDist[hi] - cumDist[lo];
    const t = span === 0 ? 0 : (targetDist - cumDist[lo]) / span;
    const a = linePoints[lo];
    const b = linePoints[hi];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }

  const slices = Array.from({ length: numBins }, () => []);
  for (let i = 0; i < numBins; i++) {
    const startDist = i * segLen;
    const endDist = i === numBins - 1 ? total : (i + 1) * segLen;
    slices[i].push(pointAt(startDist));
    for (let j = 0; j < linePoints.length; j++) {
      if (cumDist[j] > startDist && cumDist[j] < endDist) {
        slices[i].push(linePoints[j]);
      }
    }
    slices[i].push(pointAt(endDist));
  }
  return slices;
}

// Perpendicular offset for each direction's ribbon. At the typical speedmap
// zoom (~10-25 mi line across 1200px) this is ~3-5px on each side of the
// centerline — enough for the two ribbons to read as distinct without the
// rendered path straying far from the physical track.
const DUAL_DIR_OFFSET_FT = 250;

/**
 * Render a dual-direction speedmap. `branches` is an array of
 * `{ points, cumDist, binSpeedsByDir }`; each branch is rendered with its own
 * halo and directional ribbons. Branched lines (Green) pass multiple; all
 * other lines pass a single-element array.
 */
async function renderTrainSpeedmap(branches, lineColor) {
  const overlays = [];

  for (const branch of branches) {
    const { points, cumDist, binSpeedsByDir } = branch;
    // Halo for this branch so the base line is always visible.
    overlays.push(`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encodeURIComponent(encode(points))})`);

    const dirs = Object.keys(binSpeedsByDir);
    const offsetFor = (i) => {
      if (dirs.length === 1) return 0;
      return i === 0 ? DUAL_DIR_OFFSET_FT : -DUAL_DIR_OFFSET_FT;
    };

    dirs.forEach((trDr, i) => {
      const binSpeeds = binSpeedsByDir[trDr];
      const offsetFt = offsetFor(i);
      const ribbon = offsetFt === 0 ? points : offsetPolyline(points, offsetFt);
      const slices = sliceLineIntoSegments(ribbon, cumDist, binSpeeds.length);
      for (let b = 0; b < slices.length; b++) {
        if (slices[b].length < 2) continue;
        const encoded = encodeURIComponent(encode(slices[b]));
        const color = colorForTrainSpeed(binSpeeds[b]);
        overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
      }
    });
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderBunchingMap, renderSpeedmap, renderSnapshot, renderTrainBunching, renderTrainSpeedmap };
