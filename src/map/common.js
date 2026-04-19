const axios = require('axios');

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

// Twemoji 🚌 (U+1F68C) paths, 36x36 viewBox. Inlined so sharp/librsvg can render
// the emoji without needing a color emoji font on the host system.
const TWEMOJI_BUS_INNER = '<path fill="#808285" d="M0 21v7c0 1.657 1.343 3 3 3h30c1.657 0 3-1.343 3-3v-7H0z"/><path fill="#CCD6DD" d="M36 22v-9c0-1.657-3.343-3-5-3H11c-8 0-11 2.343-11 4v8h36z"/><path fill="#939598" d="M0 22h36v3H0z"/><path fill="#BCBEC0" d="M7 25c-3.063 0-5.586 2.298-5.95 5.263.526.453 1.202.737 1.95.737h10c0-3.313-2.686-6-6-6zm27.95 5.263C34.586 27.298 32.063 25 29 25c-3.313 0-6 2.687-6 6h10c.749 0 1.425-.284 1.95-.737z"/><circle cx="7" cy="31" r="4"/><circle fill="#99AAB5" cx="7" cy="31" r="2"/><circle cx="29" cy="31" r="4"/><circle fill="#99AAB5" cx="29" cy="31" r="2"/><path fill="#F4900C" d="M0 25h1v2H0zm35-2h1v2h-1z"/><path fill="#58595B" d="M1 13h35v10H1z"/><path fill="#292F33" d="M2 13H.342C.11 13.344 0 13.685 0 14v11h2c1.104 0 2-.896 2-2v-8c0-1.104-.896-2-2-2z"/><path fill="#55ACEE" d="M31 20c0 .553-.447 1-1 1H7c-.552 0-1-.447-1-1v-4c0-.552.448-1 1-1h23c.553 0 1 .448 1 1v4z"/><path fill="#FFAC33" d="M35 19h1v2h-1z"/><path fill="#55ACEE" d="M1 15H0v8h1c.552 0 1-.447 1-1v-6c0-.552-.448-1-1-1z"/>';

// Simplified house glyph, 36x36 viewBox. Marks the end-of-line terminal in
// bunching renders so viewers can see which direction the buses/trains are
// heading toward. Not a full Twemoji trace — we only need "reads as a house"
// at ~40px against the dark base map.
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

// Twemoji 🚆 (U+1F686) paths, 36x36 viewBox.
const TWEMOJI_TRAIN_INNER = '<path fill="#A7A9AC" d="M2 36h32L23 19H13z"/><path fill="#58595B" d="M5 36h26L21 19h-6z"/><path fill="#808285" d="M8 36h20l-9-17h-2z"/><path fill="#A7A9AC" d="M28 35c0 .553-.447 1-1 1H9c-.552 0-1-.447-1-1 0-.553.448-1 1-1h18c.553 0 1 .447 1 1zm-2-4c0 .553-.447 1-1 1H11c-.552 0-1-.447-1-1 0-.553.448-1 1-1h14c.553 0 1 .447 1 1z"/><path fill="#58595B" d="M27.076 25.3L23 19H13l-4.076 6.3c1.889 2.517 4.798 4.699 9.076 4.699 4.277 0 7.188-2.183 9.076-4.699z"/><path fill="#A7A9AC" d="M18 0C9 0 6 3 6 9v8c0 1.999 3 11 12 11s12-9.001 12-11V9c0-6-3-9-12-9z"/><path fill="#E6E7E8" d="M8 11C8 2 12.477 1 18 1s10 1 10 10c0 6-4.477 11-10 11-5.523-.001-10-5-10-11z"/><path fill="#FFAC33" d="M18 21.999c1.642 0 3.185-.45 4.553-1.228C21.77 19.729 20.03 19 18 19s-3.769.729-4.552 1.772c1.366.777 2.911 1.227 4.552 1.227z"/><path d="M19 4.997v4.965c3.488-.232 6-1.621 6-2.463V5.833c0-.791-3.692-.838-6-.836zm-2 0c-2.308-.002-6 .044-6 .836V7.5c0 .842 2.512 2.231 6 2.463V4.997z" fill="#55ACEE"/><path fill="#269" d="M6 10s0 3 4 9c0 0-4-2-4-6v-3zm24 0s0 3-4 9c0 0 4-2 4-6v-3z"/>';

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function requireMapboxToken() {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');
  return token;
}

async function fetchMapboxStatic(url, timeoutMs = 30000) {
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: timeoutMs });
  return data;
}

/**
 * Slice a polyline into N ordered groups by cumulative distance along the line.
 * Each slice is anchored by interpolated start/end points at exact bin
 * boundaries so sparse polylines (e.g. CTA train lines with ~80 vertices
 * across 20 mi) still produce a renderable segment per bin instead of dropping
 * bins where vertices happen to be absent.
 *
 * Normalized on {lat, lon} point objects. Callers holding [[lat, lon], ...]
 * pairs convert with one .map() before/after.
 */
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

module.exports = {
  STYLE, WIDTH, HEIGHT,
  ROUTE_HALO_COLOR, ROUTE_HALO_STROKE, ROUTE_CORE_COLOR, ROUTE_CORE_STROKE,
  SPEEDMAP_SEGMENT_STROKE, SPEEDMAP_HALO_STROKE,
  ARROW_PATH_D, buildDirectionArrow,
  TWEMOJI_BUS_INNER, TWEMOJI_TRAIN_INNER, TWEMOJI_HOUSE_INNER,
  xmlEscape, requireMapboxToken, fetchMapboxStatic,
  sliceIntoSegments,
};
