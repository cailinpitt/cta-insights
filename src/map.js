const axios = require('axios');
const sharp = require('sharp');
const { encode } = require('./polyline');
const { cumulativeDistances, haversineFt } = require('./geo');
const { colorForBusSpeed, colorForTrainSpeed } = require('./speedmap');
const { fitZoom, project } = require('./projection');

const STYLE = 'mapbox/dark-v11';
const WIDTH = 1200;
const HEIGHT = 1200;

// Two-tone route line: dark halo + bright core makes the route pop against the basemap.
const ROUTE_HALO_COLOR = '000';
const ROUTE_HALO_STROKE = 9;
const ROUTE_CORE_COLOR = '00d8ff';
const ROUTE_CORE_STROKE = 4;

const BUS_COLOR = 'ff2a6d';         // hot pink/red reads well on dark
const CONTEXT_PAD_FT = 3000;        // feet of route context on each side of the bunch

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
  const slice = slicePatternAroundBunch(pattern, bunch);
  const polyline = encode(slice.map((p) => [p.lat, p.lon]));

  const overlays = [];
  // Draw halo first, then core, so core renders on top. Pins render on top of both.
  const encoded = encodeURIComponent(polyline);
  overlays.push(`path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`);
  overlays.push(`path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`);
  // Use the Maki "bus" icon for a clear transit visual on each pin.
  for (const v of bunch.vehicles) {
    overlays.push(`pin-m-bus+${BUS_COLOR}(${v.lon.toFixed(6)},${v.lat.toFixed(6)})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;

  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });

  // Bluesky image limit is 1MB; convert to JPEG to stay under it.
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

const SPEEDMAP_SEGMENT_STROKE = 8;
const SPEEDMAP_HALO_STROKE = 12;

/**
 * Slice pattern points into N ordered groups by cumulative distance along the line.
 * Each slice gets an extra point copied from the next slice's start so adjacent
 * colored segments visually connect without gaps.
 */
function slicePatternIntoSegments(pattern, numBins) {
  const cum = cumulativeDistances(pattern.points);
  const total = cum[cum.length - 1];
  const segLen = total / numBins;

  const slices = Array.from({ length: numBins }, () => []);
  for (let i = 0; i < pattern.points.length; i++) {
    const idx = Math.min(numBins - 1, Math.floor(cum[i] / segLen));
    slices[idx].push(pattern.points[i]);
  }
  // Bridge each slice to the next so colored segments don't have visible gaps.
  for (let i = 0; i < slices.length - 1; i++) {
    if (slices[i + 1].length > 0) slices[i].push(slices[i + 1][0]);
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

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

const SNAPSHOT_WIDTH = 1200;
const SNAPSHOT_HEIGHT = 1200;

async function renderSnapshot(trains, lineColors, trainLines = null, stations = null) {
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

  // Small white station markers between lines and trains for subtle network context.
  if (stations) {
    for (const s of stations) {
      overlays.push(`pin-s+ffffff(${s.lon.toFixed(4)},${s.lat.toFixed(4)})`);
    }
  }

  // Colored pin per train, on top of stations so they're the focal point.
  for (const t of trains) {
    const color = lineColors[t.line] || 'ffffff';
    overlays.push(`pin-s+${color}(${t.lon.toFixed(4)},${t.lat.toFixed(4)})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${SNAPSHOT_WIDTH}x${SNAPSHOT_HEIGHT}@2x?access_token=${token}&padding=60`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

const TRAIN_BUNCH_CONTEXT_FT = 8000; // feet of line shown around the bunch
const TRAIN_BUNCH_NEAREST_STATIONS = 2; // how many stations to label
const TRAIN_BUNCH_BBOX_PADDING_DEG = 0.003; // ~300m — zoom out a little past the trains

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildStationLabelsSvg(stationsWithPixels, widthPx, heightPx) {
  const fontSize = 18;
  const elements = stationsWithPixels.map(({ station, x, y }) => {
    const label = xmlEscape(station.name);
    // Label centered below the pin with a background for legibility.
    const approxWidth = label.length * 10 + 16;
    const rectX = x - approxWidth / 2;
    const rectY = y + 18;
    const textX = x;
    const textY = rectY + fontSize + 2;
    return `
    <rect x="${rectX}" y="${rectY}" width="${approxWidth}" height="${fontSize + 8}" fill="#000" fill-opacity="0.8" rx="3"/>
    <text x="${textX}" y="${textY}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${label}</text>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">${elements}</svg>`;
}

async function renderTrainBunching(bunch, lineColors, trainLines, stations) {
  const color = lineColors[bunch.line] || 'ffffff';

  // Bunch center for station selection.
  const bunchLat = bunch.trains.reduce((a, t) => a + t.lat, 0) / bunch.trains.length;
  const bunchLon = bunch.trains.reduce((a, t) => a + t.lon, 0) / bunch.trains.length;

  // Pick the N stations on the bunch's line closest to the bunch — filtering
  // by line keeps us from labeling nearby stations that belong to other lines
  // (e.g. Red's Washington vs Brown's Washington/Wells, a block apart downtown).
  const onLineStations = (stations || []).filter((s) => s.lines?.includes(bunch.line));
  const nearestStations = onLineStations
    .map((s) => ({ station: s, dist: haversineFt({ lat: bunchLat, lon: bunchLon }, s) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, TRAIN_BUNCH_NEAREST_STATIONS)
    .map((x) => x.station);

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
  // which would decouple our projection math from the actual image.
  const rawZoom = fitZoom(bbox, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT, 120);
  const zoom = Math.max(10, Math.min(17, Math.floor(rawZoom)));

  // Clip line polylines to the local area so the URL stays short and only the
  // relevant track is highlighted.
  const overlays = [];
  const lineSegments = trainLines?.[bunch.line] || [];
  for (const seg of lineSegments) {
    const nearby = seg.filter(([lat, lon]) =>
      bunch.trains.some((t) => haversineFt({ lat, lon }, t) < TRAIN_BUNCH_CONTEXT_FT)
    );
    if (nearby.length < 2) continue;
    overlays.push(`path-4+${color}-0.7(${encodeURIComponent(encode(nearby))})`);
  }
  // Skip station pins that sit on top of a train pin (train is at the station).
  // The larger train pin would completely cover the station pin, leaving an
  // orphaned label. The label still draws from projected coordinates below.
  for (const s of nearestStations) {
    const coveredByTrain = bunch.trains.some((t) => haversineFt({ lat: s.lat, lon: s.lon }, t) < 200);
    if (!coveredByTrain) {
      overlays.push(`pin-s+ffffff(${s.lon.toFixed(5)},${s.lat.toFixed(5)})`);
    }
  }
  for (const t of bunch.trains) {
    overlays.push(`pin-l-rail-metro+${color}(${t.lon.toFixed(5)},${t.lat.toFixed(5)})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${SNAPSHOT_WIDTH}x${SNAPSHOT_HEIGHT}@2x?access_token=${token}`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });

  // Composite station name labels at their projected pixel positions.
  const stationsWithPixels = nearestStations.map((station) => ({
    station,
    ...project(station.lat, station.lon, centerLat, centerLon, zoom, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT),
  }));
  const svg = buildStationLabelsSvg(stationsWithPixels, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);

  return sharp(data)
    .resize(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Slice a trainLines polyline (array of [lat, lon]) into N ordered groups by
 * cumulative distance. Same bridging logic as slicePatternIntoSegments but
 * works on [lat, lon] tuples instead of {lat, lon} objects.
 */
function sliceLineIntoSegments(linePoints, cumDist, numBins) {
  const total = cumDist[cumDist.length - 1];
  const segLen = total / numBins;

  const slices = Array.from({ length: numBins }, () => []);
  for (let i = 0; i < linePoints.length; i++) {
    const idx = Math.min(numBins - 1, Math.floor(cumDist[i] / segLen));
    slices[idx].push(linePoints[i]);
  }
  for (let i = 0; i < slices.length - 1; i++) {
    if (slices[i + 1].length > 0) slices[i].push(slices[i + 1][0]);
  }
  return slices;
}

async function renderTrainSpeedmap(linePoints, cumDist, binSpeeds, lineColor) {
  const slices = sliceLineIntoSegments(linePoints, cumDist, binSpeeds.length);

  // Full-route halo in the line's own color at low opacity, then colored speed segments on top.
  const fullEncoded = encodeURIComponent(encode(linePoints));
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const encoded = encodeURIComponent(encode(slices[i]));
    const color = colorForTrainSpeed(binSpeeds[i]);
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderBunchingMap, renderSpeedmap, renderSnapshot, renderTrainBunching, renderTrainSpeedmap };
