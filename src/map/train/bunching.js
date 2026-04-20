const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { haversineFt, bearing } = require('../../shared/geo');
const { fitZoom, project } = require('../../shared/projection');
const { buildLinePolyline, snapToLine } = require('../../train/speedmap');
const { shortStationName } = require('../../train/api');
const {
  STYLE, WIDTH, HEIGHT,
  TWEMOJI_TRAIN_INNER, TWEMOJI_HOUSE_INNER, TWEMOJI_FLAG_INNER,
  buildTerminalMarker,
  buildDirectionArrow, xmlEscape, requireMapboxToken, fetchMapboxStatic,
} = require('../common');

const TRAIN_BUNCH_BBOX_PADDING_DEG = 0.003; // ~300m — zoom out a little past the trains

// Train pin radius. Set well above Mapbox pin-s (stations) so trains read as
// the primary focal point. Halo/arrow offsets are derived from this.
const TRAIN_MARKER_RADIUS = 32;
const TERMINAL_MARKER_RADIUS = TRAIN_MARKER_RADIUS;

// True geographic terminals per line, keyed by the CTA `destNm` string. Loop
// lines (Brown/Orange/Pink/Purple) return "Loop" when heading downtown — those
// have no real end-of-line, so we omit them from the map and skip the marker.
// Yellow's "Skokie" short-name maps to the Dempster-Skokie station.
const TRUE_TERMINALS = {
  red:  { 'Howard': 'Howard', '95th/Dan Ryan': '95th/Dan Ryan' },
  blue: { "O'Hare": "O'Hare", 'Forest Park': 'Forest Park' },
  g:    { 'Harlem/Lake': 'Harlem/Lake', 'Ashland/63rd': 'Ashland/63rd', 'Cottage Grove': 'Cottage Grove' },
  brn:  { 'Kimball': 'Kimball' },
  org:  { 'Midway': 'Midway' },
  p:    { 'Linden': 'Linden', 'Howard': 'Howard' },
  pink: { '54th/Cermak': '54th/Cermak' },
  y:    { 'Dempster-Skokie': 'Dempster-Skokie', 'Skokie': 'Dempster-Skokie', 'Howard': 'Howard' },
};

function findTerminal(bunch, stations) {
  const lineTerms = TRUE_TERMINALS[bunch.line];
  if (!lineTerms) return null;
  const dest = bunch.trains[0]?.destination;
  if (!dest) return null;
  const stationName = lineTerms[dest];
  if (!stationName) return null;
  const st = (stations || []).find((s) => s.name === stationName);
  return st ? { lat: st.lat, lon: st.lon } : null;
}

// Origin (start of trip) marker. CTA's API doesn't return origin, but for most
// lines the destination uniquely implies it: red/blue/p/y all have exactly two
// true terminals, so origin is whichever isn't the destination. Loop lines
// (brn/org/pink) only list one true terminal — when destination is "Loop"
// the trains came from that lone terminal; when destination IS that terminal
// they came from the Loop and we have no marker for it (skip).
//
// Green is a special case: southbound trains always originate at Harlem/Lake,
// but northbound terminate at Harlem/Lake from either Ashland/63rd or Cottage
// Grove and we can't tell which from the API — so we skip the marker only
// when destination is Harlem/Lake.
function findOrigin(bunch, stations) {
  const lineTerms = TRUE_TERMINALS[bunch.line];
  if (!lineTerms) return null;
  const dest = bunch.trains[0]?.destination;
  if (!dest) return null;
  const destStationName = lineTerms[dest] || null;
  if (bunch.line === 'g') {
    if (destStationName !== 'Ashland/63rd' && destStationName !== 'Cottage Grove') return null;
    const st = (stations || []).find((s) => s.name === 'Harlem/Lake');
    return st ? { lat: st.lat, lon: st.lon } : null;
  }
  const uniqueStations = [...new Set(Object.values(lineTerms))];
  const candidates = uniqueStations.filter((n) => n !== destStationName);
  if (candidates.length !== 1) return null;
  const st = (stations || []).find((s) => s.name === candidates[0]);
  return st ? { lat: st.lat, lon: st.lon } : null;
}

function buildTrainOverlaySvg(stationsWithPixels, atStationPixels, trainPixels, lineColor, widthPx, heightPx, terminalPixel, originPixel) {
  const fontSize = 18;
  const labelHeight = fontSize + 8;
  const gap = 4; // minimum vertical gap between labels

  // Compute initial label positions, then nudge overlapping ones apart.
  // If a train is sitting at the station, anchor the label to the train's
  // projected y (not the station's) so the label sits below the train marker
  // + halo even when the train is offset from the station centroid.
  const STATION_LABEL_OFFSET = 18;
  const TRAIN_HALO_EXTRA = 8;
  const LABEL_CLEAR_GAP = 10;
  const labels = stationsWithPixels.map(({ station, x, y, hasTrain, trainY }) => {
    const label = xmlEscape(shortStationName(station.name));
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

  // White ring halo for trains sitting at a station.
  const halos = atStationPixels.map(({ x, y }) => {
    return `<circle cx="${x}" cy="${y}" r="${TRAIN_MARKER_RADIUS + 8}" fill="none" stroke="#fff" stroke-width="4"/>`;
  });

  // Custom train markers.
  const iconSize = TRAIN_MARKER_RADIUS * 1.6;
  const trainMarkers = trainPixels.map(({ x, y }) => {
    const iconX = x - iconSize / 2;
    const iconY = y - iconSize / 2;
    return [
      `<circle cx="${x}" cy="${y}" r="${TRAIN_MARKER_RADIUS}" fill="#${lineColor}" stroke="#fff" stroke-width="4"/>`,
      `<svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 36 36">${TWEMOJI_TRAIN_INNER}</svg>`,
    ].join('');
  });

  // Direction-of-travel arrow in the top-right corner.
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

  // Origin (house) and destination (flag) markers — draw below trains so a
  // train sitting at either still reads clearly, and below labels. Either may
  // be absent (Loop-bound trains have no flag; Green has no house; off-screen
  // points are dropped upstream).
  const terminalElements = [];
  if (originPixel) terminalElements.push(...buildTerminalMarker(originPixel.x, originPixel.y, TERMINAL_MARKER_RADIUS, TWEMOJI_HOUSE_INNER));
  if (terminalPixel) terminalElements.push(...buildTerminalMarker(terminalPixel.x, terminalPixel.y, TERMINAL_MARKER_RADIUS, TWEMOJI_FLAG_INNER));

  const elements = [...terminalElements, ...halos, ...trainMarkers, ...arrows, ...labelElements].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">${elements}</svg>`;
}

function computeTrainBunchingView(bunch, lineColors, trainLines, stations, extraTrains = [], opts = {}) {
  const color = lineColors[bunch.line] || 'ffffff';

  const { points: linePts, cumDist: lineCumDist } = buildLinePolyline(trainLines, bunch.line);
  const trainTrackDists = bunch.trains.map((t) => snapToLine(t.lat, t.lon, linePts, lineCumDist));
  const minTrainDist = Math.min(...trainTrackDists);
  const maxTrainDist = Math.max(...trainTrackDists);

  const onLineStations = (stations || []).filter((s) => s.lines?.includes(bunch.line));
  const stationsWithDist = onLineStations.map((s) => ({
    station: s,
    trackDist: snapToLine(s.lat, s.lon, linePts, lineCumDist),
  }));

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

  // Build bbox to include the bunched trains AND the chosen stations.
  // Video captures pass extraTrains so later frames stay in-frame too.
  const framingTrains = [...bunch.trains, ...extraTrains];
  const allLats = [...framingTrains.map((t) => t.lat), ...nearestStations.map((s) => s.lat)];
  const allLons = [...framingTrains.map((t) => t.lon), ...nearestStations.map((s) => s.lon)];
  const bbox = {
    minLat: Math.min(...allLats) - TRAIN_BUNCH_BBOX_PADDING_DEG,
    maxLat: Math.max(...allLats) + TRAIN_BUNCH_BBOX_PADDING_DEG,
    minLon: Math.min(...allLons) - TRAIN_BUNCH_BBOX_PADDING_DEG,
    maxLon: Math.max(...allLons) + TRAIN_BUNCH_BBOX_PADDING_DEG,
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  // Integer zoom. Mapbox may round fractional zooms, decoupling our projection
  // math from the actual image. For a tight still-image bunch we ceil so the
  // frame sits tighter; for a video capture (extraTrains non-empty) or a gap
  // (opts.fitBbox) we floor — the bbox already spans what must stay on-screen,
  // so ceiling would clip trains sitting at the edges.
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 60);
  const round = extraTrains.length > 0 || opts.fitBbox ? Math.floor : Math.ceil;
  // Wide gaps (e.g. a Blue Line gap spanning Rosemont → past Harlem) need a
  // lower floor than a typical bunch — clamping to 10 re-clipped the trains
  // we were trying to keep on-screen.
  const minZoom = opts.fitBbox ? 8 : 10;
  const zoom = Math.max(minZoom, Math.min(17, round(rawZoom)));

  // Full line segments so the route runs off the edges of the frame.
  const overlays = [];
  const lineSegments = trainLines?.[bunch.line] || [];
  for (const seg of lineSegments) {
    if (seg.length < 2) continue;
    overlays.push(`path-7+${color}-0.7(${encodeURIComponent(encode(seg))})`);
  }

  // Label only the stations immediately flanking the bunch, not every on-line
  // station in the viewport. Wide bunches (e.g. Blue Line trains on both
  // branches) otherwise produced a forest of labels stretching well past the
  // bunch itself, crowding the image and pulling attention off the actual
  // event. Stations between the trains are always kept; behind/ahead are
  // capped at N on each side along the route.
  const LABELED_PER_SIDE = 3;
  const labeledSet = new Set([
    ...behind.slice(0, LABELED_PER_SIDE).map((s) => s.station.name),
    ...between.map((s) => s.station.name),
    ...ahead.slice(0, LABELED_PER_SIDE).map((s) => s.station.name),
  ]);
  const visibleStations = onLineStations
    .filter((s) => labeledSet.has(s.name))
    .map((s) => {
      const pixels = project(s.lat, s.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
      return { station: s, ...pixels };
    })
    .filter(({ x, y }) => x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT);

  for (const { station: s } of visibleStations) {
    overlays.push(`pin-s+ffffff(${s.lon.toFixed(5)},${s.lat.toFixed(5)})`);
  }

  // Compute the route-wide direction arrow once from the initial bunch.
  const allSegPoints = lineSegments.flatMap((seg) => seg.map(([lat, lon]) => ({ lat, lon })));
  function nearestSegment(pt) {
    let bestDist = Infinity;
    let bestA = null;
    let bestB = null;
    for (let i = 0; i < allSegPoints.length - 1; i++) {
      const a = allSegPoints[i];
      const b = allSegPoints[i + 1];
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
  const leadTrain = bunch.trains[0];
  let bearingDeg = leadTrain.heading;
  if (allSegPoints.length >= 2) {
    const { from, to } = nearestSegment(leadTrain);
    const fwd = bearing(from, to);
    const rev = (fwd + 180) % 360;
    const diffFwd = Math.abs(((leadTrain.heading - fwd + 540) % 360) - 180);
    const diffRev = Math.abs(((leadTrain.heading - rev + 540) % 360) - 180);
    bearingDeg = diffFwd <= diffRev ? fwd : rev;
  }

  const terminal = findTerminal(bunch, stations);
  const origin = findOrigin(bunch, stations);

  return {
    color,
    overlays,
    centerLat,
    centerLon,
    zoom,
    visibleStations,
    bearingDeg,
    terminal,
    origin,
  };
}

async function fetchTrainBunchingBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url);
}

async function renderTrainBunchingFrame(view, baseMap, trains) {
  const trainPixels = trains.map((t) => ({
    ...project(t.lat, t.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
    bearingDeg: view.bearingDeg,
  }));

  const stationsWithPixels = view.visibleStations.map(({ station, x, y }) => {
    const nearbyTrain = trains.find((t) => haversineFt({ lat: station.lat, lon: station.lon }, t) < 500);
    const trainY = nearbyTrain
      ? project(nearbyTrain.lat, nearbyTrain.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT).y
      : null;
    return { station, x, y, hasTrain: !!nearbyTrain, trainY };
  });
  const atStationPixels = trains
    .filter((t) => view.visibleStations.some((v) => haversineFt({ lat: v.station.lat, lon: v.station.lon }, t) < 500))
    .map((t) => project(t.lat, t.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT));

  function projectIfVisible(point) {
    if (!point) return null;
    const { x, y } = project(point.lat, point.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT);
    return x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT ? { x, y } : null;
  }
  const terminalPixel = projectIfVisible(view.terminal);
  const originPixel = projectIfVisible(view.origin);

  const svg = buildTrainOverlaySvg(stationsWithPixels, atStationPixels, trainPixels, view.color, WIDTH, HEIGHT, terminalPixel, originPixel);
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function renderTrainBunching(bunch, lineColors, trainLines, stations) {
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations);
  const baseMap = await fetchTrainBunchingBaseMap(view);
  return renderTrainBunchingFrame(view, baseMap, bunch.trains);
}

module.exports = {
  renderTrainBunching,
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
};
