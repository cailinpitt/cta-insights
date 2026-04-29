const axios = require('axios');
const sharp = require('sharp');

const STYLE = 'mapbox/dark-v11';
const WIDTH = 1200;
const HEIGHT = 1200;

// Two-tone route line: dark halo + bright core makes the route pop against the basemap.
const ROUTE_HALO_COLOR = '000';
const ROUTE_HALO_STROKE = 14;
const ROUTE_CORE_COLOR = '00d8ff';
const ROUTE_CORE_STROKE = 8;

const SPEEDMAP_SEGMENT_STROKE = 8;
const SPEEDMAP_HALO_STROKE = 12;

// SVG path so cross-host rendering is identical (librsvg font fallback differs
// between macOS Helvetica and Ubuntu DejaVu, which warped the Unicode arrow).
const ARROW_PATH_D = 'M -40,-30 L 0,-75 L 40,-30 M 0,-75 L 0,75';

function buildDirectionArrow(cx, cy, bearingDeg) {
  const rotation = Math.round(bearingDeg / 45) * 45;
  const transform = `translate(${cx} ${cy}) rotate(${rotation})`;
  return [
    `<path d="${ARROW_PATH_D}" fill="none" stroke="#000" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" transform="${transform}"/>`,
    `<path d="${ARROW_PATH_D}" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" transform="${transform}"/>`,
  ].join('');
}

// Custom 36-viewBox glyph styled to match the Twemoji bus: two coach
// segments + accordion bellows + 3-axle profile, so articulated buses are
// visually distinct without leaving the standard marker circle.
const ARTIC_BUS_INNER = [
  // road/shadow
  '<path fill="#808285" d="M0 22v6c0 1.6 1.3 3 3 3h30c1.6 0 3-1.4 3-3v-6H0z"/>',
  // rear segment (right, square back)
  '<path fill="#CCD6DD" d="M21 10h12c1.6 0 3 1.3 3 3v9H21z"/>',
  // front segment (left, rounded nose)
  '<path fill="#CCD6DD" d="M16 10H7c-5 0-7 1.5-7 3v9h16z"/>',
  // accordion bellows — full-height stripe through the body, ribs run top to bottom
  '<path fill="#6D7378" d="M16 10h5v21h-5z"/>',
  '<path fill="#3F4548" d="M17.2 10v21h-.4v-21zm1.4 0v21h-.4v-21zm1.4 0v21h-.4v-21z"/>',
  // body stripe
  '<path fill="#939598" d="M0 21h36v2H0z"/>',
  // wheel housings — flat fenders sized to match the standard bus's profile
  '<path fill="#BCBEC0" d="M0 31c0-1.8 2.2-3.5 5-3.5s5 1.6 5 3.5H0zm13 0c0-1.8 2.2-3.5 5-3.5s5 1.6 5 3.5H13zm13 0c0-1.8 2.2-3.5 5-3.5s5 1.6 5 3.5H26z"/>',
  // wheels — 3 axles
  '<circle cx="5" cy="32" r="3"/>',
  '<circle fill="#99AAB5" cx="5" cy="32" r="1.5"/>',
  '<circle cx="18" cy="32" r="3"/>',
  '<circle fill="#99AAB5" cx="18" cy="32" r="1.5"/>',
  '<circle cx="31" cy="32" r="3"/>',
  '<circle fill="#99AAB5" cx="31" cy="32" r="1.5"/>',
  // rear-segment windows
  '<path fill="#55ACEE" stroke="#3F4548" stroke-width="1" stroke-linejoin="round" d="M22 13h12c.6 0 1 .4 1 1v5c0 .6-.4 1-1 1H22z"/>',
  // front-segment passenger windows
  '<path fill="#55ACEE" stroke="#3F4548" stroke-width="1" stroke-linejoin="round" d="M5 13h10v7H5z"/>',
  // windshield — raked front pane in a lighter shade
  '<path fill="#9CCEF0" stroke="#3F4548" stroke-width="1" stroke-linejoin="round" d="M3 13h2v7H1v-3.5z"/>',
  // headlight — yellow lamp on the front fascia
  '<circle fill="#FFEB3B" cx="0.9" cy="21.3" r="0.9"/>',
  // taillights — red lamps on the rear fascia
  '<rect fill="#E53935" x="34.5" y="14" width="1.5" height="2" rx="0.3"/>',
  '<rect fill="#E53935" x="34.5" y="18" width="1.5" height="2" rx="0.3"/>',
].join('');

// Inlined Twemoji paths so rendering doesn't need a color emoji font.
const TWEMOJI_BUS_INNER =
  '<path fill="#808285" d="M0 21v7c0 1.657 1.343 3 3 3h30c1.657 0 3-1.343 3-3v-7H0z"/><path fill="#CCD6DD" d="M36 22v-9c0-1.657-3.343-3-5-3H11c-8 0-11 2.343-11 4v8h36z"/><path fill="#939598" d="M0 22h36v3H0z"/><path fill="#BCBEC0" d="M7 25c-3.063 0-5.586 2.298-5.95 5.263.526.453 1.202.737 1.95.737h10c0-3.313-2.686-6-6-6zm27.95 5.263C34.586 27.298 32.063 25 29 25c-3.313 0-6 2.687-6 6h10c.749 0 1.425-.284 1.95-.737z"/><circle cx="7" cy="31" r="4"/><circle fill="#99AAB5" cx="7" cy="31" r="2"/><circle cx="29" cy="31" r="4"/><circle fill="#99AAB5" cx="29" cy="31" r="2"/><path fill="#F4900C" d="M0 25h1v2H0zm35-2h1v2h-1z"/><path fill="#58595B" d="M1 13h35v10H1z"/><path fill="#292F33" d="M2 13H.342C.11 13.344 0 13.685 0 14v11h2c1.104 0 2-.896 2-2v-8c0-1.104-.896-2-2-2z"/><path fill="#55ACEE" d="M31 20c0 .553-.447 1-1 1H7c-.552 0-1-.447-1-1v-4c0-.552.448-1 1-1h23c.553 0 1 .448 1 1v4z"/><path fill="#FFAC33" d="M35 19h1v2h-1z"/><path fill="#55ACEE" d="M1 15H0v8h1c.552 0 1-.447 1-1v-6c0-.552-.448-1-1-1z"/>';

// Simplified house, sized for ~40px on a dark basemap.
const TWEMOJI_HOUSE_INNER = [
  // chimney (sits behind the roof peak)
  '<rect fill="#6D3A2C" x="24" y="4" width="4.5" height="2"/>',
  '<rect fill="#8A4B38" x="24" y="6" width="4.5" height="7"/>',
  // roof — darker brown with overhang past the walls
  '<path fill="#8B4423" d="M18 1 L0 19 L4 19 L4 35 L32 35 L32 19 L36 19 Z"/>',
  // walls
  '<path fill="#FFCC4D" d="M5 19 L18 7 L31 19 L31 35 L5 35 Z"/>',
  // roof trim line where roof meets walls
  '<rect fill="#E8A935" x="5" y="19" width="26" height="2"/>',
  // door
  '<rect fill="#A0241B" x="14.5" y="24" width="7" height="11"/>',
  // door knob
  '<circle fill="#FFD700" cx="20" cy="30" r="0.8"/>',
  // left window: dark frame, blue pane, white cross mullion
  '<rect fill="#6D3A2C" x="7" y="23" width="6" height="6"/>',
  '<rect fill="#55ACEE" x="7.7" y="23.7" width="4.6" height="4.6"/>',
  '<rect fill="#fff" x="9.85" y="23.7" width="0.3" height="4.6"/>',
  '<rect fill="#fff" x="7.7" y="25.85" width="4.6" height="0.3"/>',
  // right window
  '<rect fill="#6D3A2C" x="23" y="23" width="6" height="6"/>',
  '<rect fill="#55ACEE" x="23.7" y="23.7" width="4.6" height="4.6"/>',
  '<rect fill="#fff" x="25.85" y="23.7" width="0.3" height="4.6"/>',
  '<rect fill="#fff" x="23.7" y="25.85" width="4.6" height="0.3"/>',
].join('');

// Checkered flag — destination marker, paired with the house at origin.
const TWEMOJI_FLAG_INNER = [
  // pole
  '<rect fill="#3B2412" x="7.5" y="3" width="2" height="30"/>',
  // pole tip
  '<circle fill="#FFD700" cx="8.5" cy="3" r="1.5"/>',
  // flag white background
  '<rect fill="#FFFFFF" x="9.5" y="6" width="22" height="12"/>',
  // checker squares (5.5w × 4h, black on alternating cells)
  '<rect fill="#000" x="9.5"  y="6"  width="5.5" height="4"/>',
  '<rect fill="#000" x="20.5" y="6"  width="5.5" height="4"/>',
  '<rect fill="#000" x="15"   y="10" width="5.5" height="4"/>',
  '<rect fill="#000" x="26"   y="10" width="5.5" height="4"/>',
  '<rect fill="#000" x="9.5"  y="14" width="5.5" height="4"/>',
  '<rect fill="#000" x="20.5" y="14" width="5.5" height="4"/>',
  // outline
  '<rect fill="none" stroke="#000" stroke-width="0.6" x="9.5" y="6" width="22" height="12"/>',
].join('');

// Bus-stop sign: square amber placard with a white mini-bus glyph. Amber
// (#f57c00) sits well clear of the cyan route line and the pink buses on a
// dark basemap. Drawn from primitives for cross-host stability. Sized for a
// 36×36 viewBox — fills the box edge-to-edge so callers can size by `size`.
const TWEMOJI_BUS_STOP_INNER = [
  // square sign placard, full viewBox
  '<rect fill="#f57c00" stroke="#fff" stroke-width="2" x="2" y="2" width="32" height="32" rx="3" ry="3"/>',
  // mini bus body
  '<rect fill="#fff" x="7" y="10" width="22" height="16" rx="2" ry="2"/>',
  // window strip
  '<rect fill="#f57c00" x="9" y="12" width="18" height="6" rx="0.8" ry="0.8"/>',
  // wheels
  '<circle fill="#222" cx="12" cy="26" r="2.3"/>',
  '<circle fill="#222" cx="24" cy="26" r="2.3"/>',
].join('');

function buildStopMarker(x, y, size) {
  return `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 36 36">${TWEMOJI_BUS_STOP_INNER}</svg>`;
}

// Articulated marker uses electric violet — a vivid hue clearly distinct
// from the standard hot-pink, so the easter egg reads at a glance against
// the dark basemap.
const ARTIC_MARKER_COLOR = 'c026ff';

// Bus marker. Articulated buses get both a distinct glyph (two coach
// segments + bellows + 3 axles) and a deeper background color. `articulated`
// is optional; omitting it yields the standard fleet marker.
function buildBusMarker({ x, y, radius, color, articulated = false }) {
  const size = radius * 1.6;
  const inner = articulated ? ARTIC_BUS_INNER : TWEMOJI_BUS_INNER;
  const fill = articulated ? ARTIC_MARKER_COLOR : color;
  // Layer order: fill circle → bus glyph → white stroke ring on top, so the
  // ring crisply frames the bus instead of being clipped beneath it.
  return [
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="#${fill}"/>`,
    `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 36 36">${inner}</svg>`,
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#fff" stroke-width="4"/>`,
  ].join('');
}

function buildTerminalMarker(x, y, radius, glyph) {
  const iconSize = radius * 1.6;
  const iconX = x - iconSize / 2;
  const iconY = y - iconSize / 2;
  return [
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="#7cb342"/>`,
    `<svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 36 36">${glyph}</svg>`,
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#fff" stroke-width="4"/>`,
  ];
}

// Twemoji 🚆 (U+1F686) paths, 36x36 viewBox.
const TWEMOJI_TRAIN_INNER =
  '<path fill="#A7A9AC" d="M2 36h32L23 19H13z"/><path fill="#58595B" d="M5 36h26L21 19h-6z"/><path fill="#808285" d="M8 36h20l-9-17h-2z"/><path fill="#A7A9AC" d="M28 35c0 .553-.447 1-1 1H9c-.552 0-1-.447-1-1 0-.553.448-1 1-1h18c.553 0 1 .447 1 1zm-2-4c0 .553-.447 1-1 1H11c-.552 0-1-.447-1-1 0-.553.448-1 1-1h14c.553 0 1 .447 1 1z"/><path fill="#58595B" d="M27.076 25.3L23 19H13l-4.076 6.3c1.889 2.517 4.798 4.699 9.076 4.699 4.277 0 7.188-2.183 9.076-4.699z"/><path fill="#A7A9AC" d="M18 0C9 0 6 3 6 9v8c0 1.999 3 11 12 11s12-9.001 12-11V9c0-6-3-9-12-9z"/><path fill="#E6E7E8" d="M8 11C8 2 12.477 1 18 1s10 1 10 10c0 6-4.477 11-10 11-5.523-.001-10-5-10-11z"/><path fill="#FFAC33" d="M18 21.999c1.642 0 3.185-.45 4.553-1.228C21.77 19.729 20.03 19 18 19s-3.769.729-4.552 1.772c1.366.777 2.911 1.227 4.552 1.227z"/><path d="M19 4.997v4.965c3.488-.232 6-1.621 6-2.463V5.833c0-.791-3.692-.838-6-.836zm-2 0c-2.308-.002-6 .044-6 .836V7.5c0 .842 2.512 2.231 6 2.463V4.997z" fill="#55ACEE"/><path fill="#269" d="M6 10s0 3 4 9c0 0-4-2-4-6v-3zm24 0s0 3-4 9c0 0 4-2 4-6v-3z"/>';

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function requireMapboxToken() {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');
  return token;
}

async function fetchMapboxStatic(url, timeoutMs = 30000) {
  // One retry with jittered backoff for transient 429/5xx.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: timeoutMs });
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) {
        const wait = 500 + Math.floor(Math.random() * 750);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// Interpolated start/end points at exact bin boundaries — sparse polylines
// (CTA train lines have ~80 vertices over 20 mi) would otherwise drop bins.
function sliceIntoSegments(points, cumDist, numBins) {
  const total = cumDist[cumDist.length - 1];
  const segLen = total / numBins;

  function pointAt(targetDist) {
    if (targetDist <= cumDist[0]) return points[0];
    if (targetDist >= cumDist[cumDist.length - 1]) return points[points.length - 1];
    let lo = 0;
    let hi = cumDist.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cumDist[mid] <= targetDist) lo = mid;
      else hi = mid;
    }
    const span = cumDist[hi] - cumDist[lo];
    const t = span === 0 ? 0 : (targetDist - cumDist[lo]) / span;
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
      if (cumDist[j] > startDist && cumDist[j] < endDist) {
        slices[i].push(points[j]);
      }
    }
    slices[i].push(pointAt(endDist));
  }
  return slices;
}

// `opts.axis` (pixel-space unit vector) constrains pushes to ±axis. Pass the
// route-perpendicular axis so a bunch fans sideways instead of spreading along
// the road, which would make tight bunches look spread out.
function separateMarkers(points, minDist, opts = {}) {
  const { axis, maxIterations = 60 } = opts;
  const out = points.map((p) => ({ ...p }));
  for (let iter = 0; iter < maxIterations; iter++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const dx = out[j].x - out[i].x;
        const dy = out[j].y - out[i].y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= minDist * minDist) continue;

        if (axis) {
          // Project onto axis; if the perpendicular component already clears minDist, we're done.
          const a = dx * axis.x + dy * axis.y;
          const perp2 = Math.max(0, dist2 - a * a);
          if (perp2 >= minDist * minDist) continue;
          const targetAbs = Math.sqrt(minDist * minDist - perp2);
          // Below STABLE_THRESH, GPS noise can flip Math.sign(a) frame-to-frame
          // and produce a video shimmer — fall back to caller-order sign.
          const STABLE_THRESH = minDist * 0.2;
          const sign = Math.abs(a) < STABLE_THRESH ? 1 : Math.sign(a);
          const targetA = sign * targetAbs;
          const delta = (targetA - a) / 2;
          out[i].x -= axis.x * delta;
          out[i].y -= axis.y * delta;
          out[j].x += axis.x * delta;
          out[j].y += axis.y * delta;
          moved = true;
        } else {
          const dist = Math.sqrt(dist2);
          let ux;
          let uy;
          if (dist < 1e-6) {
            const angle = ((i * 97 + j * 31) % 360) * (Math.PI / 180);
            ux = Math.cos(angle);
            uy = Math.sin(angle);
          } else {
            ux = dx / dist;
            uy = dy / dist;
          }
          const push = (minDist - dist) / 2;
          out[i].x -= ux * push;
          out[i].y -= uy * push;
          out[j].x += ux * push;
          out[j].y += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return out;
}

// Compass bearing → pixel-space perpendicular (rotated 90° CW = right of travel).
function perpendicularFromBearing(bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

module.exports = {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  ROUTE_HALO_STROKE,
  ROUTE_CORE_COLOR,
  ROUTE_CORE_STROKE,
  SPEEDMAP_SEGMENT_STROKE,
  SPEEDMAP_HALO_STROKE,
  ARROW_PATH_D,
  buildDirectionArrow,
  TWEMOJI_BUS_INNER,
  TWEMOJI_TRAIN_INNER,
  TWEMOJI_HOUSE_INNER,
  TWEMOJI_FLAG_INNER,
  TWEMOJI_BUS_STOP_INNER,
  buildBusMarker,
  buildTerminalMarker,
  buildStopMarker,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  sliceIntoSegments,
  separateMarkers,
  perpendicularFromBearing,
  measureTextWidth,
  paddedBbox,
  bboxOf,
};

// Real glyph measurement via librsvg — the same renderer that draws the SVG
// composite. The earlier per-character estimator was a guess that drifted
// every time a new title format was introduced (bold weight, em dashes,
// route lists, "service impact" vs "service alert") and the pill kept
// either clipping or trailing dead space. Always use this for pill sizing.
async function measureTextWidth(text, fontSize, { bold = false } = {}) {
  const weight = bold ? 'bold' : 'normal';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${Math.ceil(fontSize * 2)}"><text x="0" y="${fontSize}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}">${xmlEscape(text)}</text></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  let maxX = 0;
  const stride = info.channels;
  for (let y = 0; y < info.height; y++) {
    for (let x = info.width - 1; x > maxX; x--) {
      const alpha = data[(y * info.width + x) * stride + (stride - 1)];
      if (alpha > 8) {
        if (x > maxX) maxX = x;
        break;
      }
    }
  }
  return maxX + 1;
}

function bboxOf(points) {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (const p of points) {
    const lat = Array.isArray(p) ? p[0] : p.lat;
    const lon = Array.isArray(p) ? p[1] : p.lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

function paddedBbox(bbox, fracMargin, minSpanDeg) {
  const latSpan = Math.max(bbox.maxLat - bbox.minLat, minSpanDeg);
  const lonSpan = Math.max(bbox.maxLon - bbox.minLon, minSpanDeg);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const padLat = (latSpan * (1 + fracMargin)) / 2;
  const padLon = (lonSpan * (1 + fracMargin)) / 2;
  return {
    minLat: centerLat - padLat,
    maxLat: centerLat + padLat,
    minLon: centerLon - padLon,
    maxLon: centerLon + padLon,
  };
}
