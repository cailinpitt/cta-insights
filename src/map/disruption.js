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
const { inLoopTrunk } = require('../train/speedmap');

// CTA Loop elevated stations in clockwise order. The GTFS shapes encode the
// Loop as a sparse rectangle (one vertex per corner), so the Mapbox overlay
// cuts straight across each side instead of following the actual track —
// glaringly off on disruption renders that frame the Loop. Inserting these
// station coords as intermediate vertices on any polyline leg that crosses
// the Loop trunk bends each side through its real station positions and
// makes the overlay sit on the basemap's L track.
const LOOP_STATIONS_CW = [
  { lat: 41.8857, lon: -87.6309 }, // Clark/Lake (north side, west)
  { lat: 41.8832, lon: -87.6262 }, // Washington/Wabash (east side, north)
  { lat: 41.8795, lon: -87.626 }, // Adams/Wabash (east side, mid)
  { lat: 41.8769, lon: -87.6282 }, // Library (south side, east)
  { lat: 41.8768, lon: -87.6317 }, // LaSalle/Van Buren (south side, west)
  { lat: 41.8787, lon: -87.6337 }, // Quincy (west side, south)
  { lat: 41.8827, lon: -87.6338 }, // Washington/Wells (west side, north)
];

// For each consecutive vertex pair where at least one endpoint lies in the
// Loop trunk bbox, project each Loop station onto the leg and insert any
// whose perpendicular distance is small (< ~250m) and whose along-leg
// fraction is interior. Keeps non-Loop geometry untouched.
function densifyLoopPolyline(seg) {
  if (seg.length < 2) return seg;
  // Each Loop station should appear at most once per traversal of the
  // polyline through the trunk: on a closed round-trip line the trunk is
  // traversed twice (outbound→inbound transition, then return), and a
  // station may also project validly onto an adjacent approach leg as well
  // as its own Loop side. Toggle "inLoopRun" tracks whether we've entered
  // the trunk; inserted stations reset on each exit so the return-leg pass
  // can still pick them up.
  let insertedThisRun = new Set();
  let prevInTrunk = false;
  const out = [seg[0]];
  for (let i = 1; i < seg.length; i++) {
    const a = seg[i - 1];
    const b = seg[i];
    const aIn = inLoopTrunk(a[0], a[1]);
    const bIn = inLoopTrunk(b[0], b[1]);
    if (prevInTrunk && !aIn) insertedThisRun = new Set();
    prevInTrunk = aIn;
    if (aIn && bIn) {
      const dy = b[0] - a[0];
      const dx = b[1] - a[1];
      const lenSq = dx * dx + dy * dy;
      if (lenSq > 0) {
        const inserts = [];
        for (let si = 0; si < LOOP_STATIONS_CW.length; si++) {
          if (insertedThisRun.has(si)) continue;
          const s = LOOP_STATIONS_CW[si];
          const t = ((s.lon - a[1]) * dx + (s.lat - a[0]) * dy) / lenSq;
          if (t <= 0.02 || t >= 0.98) continue;
          const projLat = a[0] + t * dy;
          const projLon = a[1] + t * dx;
          const perpM = latLonDistMeters([projLat, projLon], s);
          if (perpM > 100) continue;
          inserts.push({ t, si, lat: s.lat, lon: s.lon });
        }
        inserts.sort((x, y) => x.t - y.t);
        for (const ins of inserts) {
          out.push([ins.lat, ins.lon]);
          insertedThisRun.add(ins.si);
        }
      }
    }
    out.push(b);
  }
  return out;
}

// Equirectangular — fine for ranking nearest vertex over central Chicago.
function latLonDistMeters([lat, lon], loc) {
  const dLat = (lat - loc.lat) * 111320;
  const dLon = (lon - loc.lon) * 111320 * Math.cos((loc.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

// Round-trip lines (Pink, Brown, Orange, Purple) ship as a single polyline
// going outbound terminal → Loop → back to outbound terminal. Splitting
// such a polyline naively means the "second active" half on the return leg
// physically passes through the suspended span, drawing bright stroke over
// the dim overlay and making short-stretch suspensions invisible (Pink
// California↔Western, ~0.5 mi). Truncate at the apex (vertex farthest from
// the start) so we render only one direction of the loop. Mirrors the same
// logic in src/train/speedmap.js processSegment used by the detector.
function truncateRoundTrip(seg, fromLoc = null, toLoc = null) {
  if (seg.length < 3) return seg;
  const first = { lat: seg[0][0], lon: seg[0][1] };
  const last = { lat: seg[seg.length - 1][0], lon: seg[seg.length - 1][1] };
  const closingDist = latLonDistMeters([last.lat, last.lon], first);
  if (closingDist > 150) return seg; // open polyline — terminus to terminus
  let apexIdx = 0;
  let apexDist = 0;
  for (let i = 1; i < seg.length; i++) {
    const d = latLonDistMeters(seg[i], first);
    if (d > apexDist) {
      apexDist = d;
      apexIdx = i;
    }
  }
  const plateauThreshold = apexDist * 0.9;
  let exitIdx = seg.length - 1;
  for (let i = apexIdx + 1; i < seg.length; i++) {
    if (latLonDistMeters(seg[i], first) < plateauThreshold) {
      exitIdx = i - 1;
      break;
    }
  }
  // If either disruption endpoint is closer to the dropped (return-leg) half
  // than to the kept half, the disruption sits on the apex — typically a Loop
  // section for Brown/Orange/Pink/Purple. Truncating in that case chops the
  // very geometry the suspended segment lives on, leaving splitSegments
  // unable to find from/to and producing weird overlay/bbox output. Skip
  // truncation and return the full polyline; for Loop segments the active2
  // overlap doesn't visibly compete because the dim stretch covers the
  // entire apex.
  if (fromLoc || toLoc) {
    const distToKept = (loc) => {
      let best = Infinity;
      for (let i = 0; i <= exitIdx; i++) {
        const d = latLonDistMeters(seg[i], loc);
        if (d < best) best = d;
      }
      return best;
    };
    const distToDropped = (loc) => {
      let best = Infinity;
      for (let i = exitIdx + 1; i < seg.length; i++) {
        const d = latLonDistMeters(seg[i], loc);
        if (d < best) best = d;
      }
      return best;
    };
    for (const loc of [fromLoc, toLoc].filter(Boolean)) {
      if (distToDropped(loc) < distToKept(loc)) return seg;
    }
  }
  return seg.slice(0, exitIdx + 1);
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
  // Branched lines (Green: Ashland/63rd vs Cottage Grove; Red: 95th vs the
  // unused stub) ship as separate polylines that share a trunk. A station
  // on one branch can still find a closeish nearest vertex on the *other*
  // branch (e.g. Cottage Grove → 1.3 km from a vertex on the Ashland/63rd
  // segment, well under nearestVertexIdx's 4 km cutoff), so naïvely
  // splitting every segment dims a bogus stretch on the wrong branch and
  // blows up the bbox. Pick the segment whose (from+to) snaps are tightest
  // and split only that one; treat the others as fully active.
  const prepared = segments.map((rawSeg) => {
    const seg = truncateRoundTrip(densifyLoopPolyline(rawSeg), fromLoc, toLoc);
    if (seg.length < 2) return { seg };
    const from = nearestVertexInfo(seg, fromLoc);
    const to = nearestVertexInfo(seg, toLoc);
    return { seg, from, to };
  });
  let bestI = -1;
  let bestScore = Infinity;
  for (let i = 0; i < prepared.length; i++) {
    const { from, to } = prepared[i];
    if (!from || !to || from.idx == null || to.idx == null) continue;
    const score = from.distMeters + to.distMeters;
    if (score < bestScore) {
      bestScore = score;
      bestI = i;
    }
  }
  for (let i = 0; i < prepared.length; i++) {
    const { seg } = prepared[i];
    if (seg.length < 2) continue;
    if (i !== bestI) {
      active.push(seg);
      continue;
    }
    const fromIdx = prepared[i].from.idx;
    const toIdx = prepared[i].to.idx;
    if (fromIdx === toIdx) {
      // Close-together stations (e.g. California ↔ Western on Pink, ~0.3 mi)
      // can both snap to the same polyline vertex. Earlier this fell through
      // to "leave whole thing bright," producing a map with no dim segment
      // at all. Synthesize a short dim slice through the shared vertex,
      // ordering the endpoints by which side of the vertex each falls on.
      const k = fromIdx;
      const before = k > 0 ? seg[k - 1] : null;
      const after = k < seg.length - 1 ? seg[k + 1] : null;
      const fromNearBefore =
        before &&
        (after ? latLonDistMeters(before, fromLoc) < latLonDistMeters(after, fromLoc) : true);
      const [first, second] = fromNearBefore ? [fromLoc, toLoc] : [toLoc, fromLoc];
      const firstPt = [first.lat, first.lon];
      const secondPt = [second.lat, second.lon];
      const head = seg.slice(0, k);
      const tail = seg.slice(k + 1);
      if (head.length > 0) active.push([...head, firstPt]);
      suspended.push([firstPt, seg[k], secondPt]);
      if (tail.length > 0) active.push([secondPt, ...tail]);
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
  const info = nearestVertexInfo(seg, loc);
  return info ? info.idx : null;
}

function nearestVertexInfo(seg, loc) {
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
  if (bestD >= 4000) return null;
  return { idx: bestIdx, distMeters: bestD };
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
  // Active polylines first, suspended last. Mapbox draws overlays in URL
  // order with later overlays on top, so we want the dim segment ON TOP of
  // the active strokes. Each active polyline ends with a rounded line cap
  // at the station endpoint (cap radius = strokeWidth/2). On short
  // stretches like Pink California→Western (~85px between stations) the
  // caps from each side extend ~5px into the suspended span and visually
  // bridge it — the dim segment got buried under bright caps and looked
  // continuous. Drawing suspended last covers the cap overlap so the dim
  // is unambiguous edge-to-edge.
  for (const seg of active) {
    if (!seg || seg.length < 2) continue;
    overlays.push(`path-10+${color}-0.95(${encodeURIComponent(encode(seg))})`);
  }
  // Suspended: same stroke width as active so the dim is visually "the
  // route line, dimmed" rather than a thinner side-trace. 0.4 opacity is
  // the same value that's worked on long-stretch Blue/Red disruptions for
  // months — what was failing on short stretches was the draw order, not
  // the styling.
  for (const seg of suspended) {
    if (!seg || seg.length < 2) continue;
    overlays.push(`path-10+${color}-0.4(${encodeURIComponent(encode(seg))})`);
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
  const defaultTitle =
    disruption.source === 'cta-alert'
      ? `⚠ ${lineName} Line suspended`
      : `⚠ ${lineName} Line: trains not seen`;
  const titleText = title || defaultTitle;
  const titleFontSize = 42;
  // Real glyph measurement via the same renderer that draws the SVG. Earlier
  // estimators (flat 24px/char, then per-glyph ratios) drifted on each new
  // title format and either clipped the text or trailed dead space.
  const titleWidth = 48 + (await measureTextWidth(titleText, titleFontSize, { bold: true }));

  const fromPx = project(fromLoc.lat, fromLoc.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const toPx = project(toLoc.lat, toLoc.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const labels = await pairedStationLabels([
    { name: fromLoc.name, px: fromPx },
    { name: toLoc.name, px: toPx },
  ]);

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

async function pairedStationLabels(stations) {
  // Resolve each label's geometry first, then assign above/below so that
  // when two close-together stations would collide horizontally we put one
  // above the dot and the other below instead of stacking them on top of
  // each other.
  const layouts = [];
  for (const s of stations) {
    if (!s.name || !Number.isFinite(s.px.x) || !Number.isFinite(s.px.y)) continue;
    const text = s.name.split(' (')[0]; // drop "(Red)" style disambiguation
    const fontSize = 28;
    const pad = 12;
    const textW = await measureTextWidth(text, fontSize);
    const pillW = textW + pad * 2;
    const h = fontSize + pad * 1.4;
    const xPill = Math.round(s.px.x - pillW / 2);
    const above = Math.round(s.px.y - h - 14);
    const below = Math.round(s.px.y + 14);
    const wouldHitTitle =
      above < TITLE_KEEPOUT.y + TITLE_KEEPOUT.h &&
      xPill < TITLE_KEEPOUT.x + TITLE_KEEPOUT.w &&
      xPill + pillW > TITLE_KEEPOUT.x;
    const forcedBelow = above < 8 || wouldHitTitle;
    layouts.push({ px: s.px, text, fontSize, pad, pillW, h, xPill, above, below, forcedBelow });
  }

  function rectsOverlap(a, b) {
    return !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
  }
  function pillRect(l, y) {
    return { left: l.xPill, right: l.xPill + l.pillW, top: y, bottom: y + l.h };
  }

  // First pass: each label takes its preferred slot.
  const ys = layouts.map((l) => (l.forcedBelow ? l.below : l.above));

  // If two labels collide and neither is forced, flip the second to below.
  for (let i = 0; i < layouts.length; i++) {
    for (let j = i + 1; j < layouts.length; j++) {
      const a = pillRect(layouts[i], ys[i]);
      const b = pillRect(layouts[j], ys[j]);
      if (!rectsOverlap(a, b)) continue;
      if (!layouts[j].forcedBelow && ys[j] !== layouts[j].below) {
        ys[j] = layouts[j].below;
      } else if (!layouts[i].forcedBelow && ys[i] !== layouts[i].below) {
        ys[i] = layouts[i].below;
      }
      // If both are forced or already split and still collide, leave it —
      // we'd rather have readable overlap than push a pill off-screen.
    }
  }

  return layouts
    .map((l, i) => {
      const y = ys[i];
      return [
        `<rect x="${l.xPill}" y="${y}" width="${Math.round(l.pillW)}" height="${Math.round(l.h)}" fill="#000" fill-opacity="0.82" rx="8"/>`,
        `<text x="${Math.round(l.px.x)}" y="${Math.round(y + l.h - l.pad)}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${l.fontSize}" font-weight="600">${xmlEscape(l.text)}</text>`,
        `<circle cx="${Math.round(l.px.x)}" cy="${Math.round(l.px.y)}" r="18" fill="#fff" stroke="#000" stroke-width="5"/>`,
      ].join('');
    })
    .join('\n');
}

module.exports = { renderDisruption, splitSegments, resolveStation };
