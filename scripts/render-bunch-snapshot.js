#!/usr/bin/env node
// Render a multi-route bus snapshot near an intersection for a given moment.
// Pulls bus positions from the observations table, snaps each bus to its route
// polyline, and composites markers + labels onto a Mapbox dark basemap.
//
// Usage:
//   node scripts/render-bunch-snapshot.js \
//     --routes=8,56,65,66 \
//     --center=41.8911,-87.6477 \
//     --label="Halsted & Grand/Milwaukee" \
//     --at=2026-05-13T13:44:03Z \
//     [--peak-between=2026-05-13T11:00Z..2026-05-13T17:00Z] \
//     [--radius=0.4]   miles, default 0.4
//     [--zoom=15.6]
//     [--size=900x900]
//     [--out=tmp/bunch-snapshot.png]
//
// Either --at OR --peak-between is required. With --peak-between the script
// scans the window and picks the snapshot ts with the most distinct buses
// (across the requested routes) inside the bbox.

require('../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const minimist = require('minimist');
const axios = require('axios');
const sharp = require('sharp');

const { getDb } = require('../src/shared/history');
const { encode } = require('../src/shared/polyline');
const { project } = require('../src/shared/projection');
const { haversineFt } = require('../src/shared/geo');
const { buildBusMarker, separateMarkers, measureTextWidth } = require('../src/map/common');
const { isArticulated } = require('../src/bus/fleet');

// Default route -> color mapping. Anything not listed falls through to a
// rotating palette so unknown routes still get distinct hues.
const ROUTE_COLORS = {
  8: 'ff5252', // Halsted
  9: 'f44336', // Ashland
  20: 'ff7043', // Madison
  49: 'ab47bc', // Western
  53: 'ec407a', // Pulaski
  56: '7cb342', // Milwaukee
  65: 'ff9800', // Grand
  66: '42a5f5', // Chicago
  77: '5c6bc0', // Belmont
  79: '00acc1', // 79th
  X9: 'b71c1c',
};
const FALLBACK_COLORS = ['00bcd4', 'ffeb3b', 'd500f9', '8d6e63', '00e676', 'ff4081', 'ffc107'];

// Route -> human name. Used only for the legend; falls back to "Route N".
const ROUTE_NAMES = {
  8: 'Halsted',
  9: 'Ashland',
  20: 'Madison',
  49: 'Western',
  53: 'Pulaski',
  56: 'Milwaukee',
  65: 'Grand',
  66: 'Chicago',
  77: 'Belmont',
  79: '79th',
};

const MILES_TO_DEG_LAT = 1 / 69.0;

function parseArgs() {
  const argv = minimist(process.argv.slice(2));
  const need = (k) => {
    if (argv[k] == null) throw new Error(`Missing --${k}`);
    return argv[k];
  };
  const routes = String(need('routes'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const [latStr, lonStr] = String(need('center')).split(',');
  const center = { lat: parseFloat(latStr), lon: parseFloat(lonStr) };
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
    throw new Error('--center must be lat,lon');
  }
  const label = String(need('label'));
  const radius = parseFloat(argv.radius ?? '0.4');
  const zoom = parseFloat(argv.zoom ?? '15.6');
  const [wStr, hStr] = String(argv.size ?? '900x900').split('x');
  const width = parseInt(wStr, 10);
  const height = parseInt(hStr, 10);
  const out = argv.out ?? 'tmp/bunch-snapshot.png';

  let at = null,
    peakBetween = null;
  if (argv.at) at = new Date(argv.at).getTime();
  if (argv['peak-between']) {
    const [s, e] = String(argv['peak-between']).split('..');
    peakBetween = { start: new Date(s).getTime(), end: new Date(e).getTime() };
  }
  if (!at && !peakBetween) throw new Error('Provide --at or --peak-between');

  return { routes, center, label, radius, zoom, width, height, out, at, peakBetween };
}

function bboxForCenter(center, radiusMi) {
  const dLat = radiusMi * MILES_TO_DEG_LAT;
  const dLon = radiusMi / (Math.cos((center.lat * Math.PI) / 180) * 69.0);
  return {
    south: center.lat - dLat,
    north: center.lat + dLat,
    west: center.lon - dLon,
    east: center.lon + dLon,
  };
}

function colorForRoute(route, idx) {
  return ROUTE_COLORS[route] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
}

function nameForRoute(route) {
  return ROUTE_NAMES[route] || `Route ${route}`;
}

// Pick the snapshot with the most distinct buses (route+vehicle) inside bbox
// across the requested routes, anywhere in [start, end].
function findPeakSnapshot(routes, bbox, start, end) {
  const placeholders = routes.map(() => '?').join(',');
  const row = getDb()
    .prepare(`
    SELECT ts, COUNT(DISTINCT route || '-' || vehicle_id) AS buses
    FROM observations
    WHERE kind = 'bus'
      AND route IN (${placeholders})
      AND ts BETWEEN ? AND ?
      AND lat BETWEEN ? AND ?
      AND lon BETWEEN ? AND ?
    GROUP BY ts
    ORDER BY buses DESC, ts ASC
    LIMIT 1
  `)
    .get(...routes, start, end, bbox.south, bbox.north, bbox.west, bbox.east);
  return row?.ts ?? null;
}

// Snapshot ts closest to `target` within ±windowMs, restricted to rows in bbox.
function findSnapshotNear(routes, bbox, target, windowMs = 120_000) {
  const placeholders = routes.map(() => '?').join(',');
  const row = getDb()
    .prepare(`
    SELECT ts FROM observations
    WHERE kind = 'bus'
      AND route IN (${placeholders})
      AND ts BETWEEN ? AND ?
      AND lat BETWEEN ? AND ?
      AND lon BETWEEN ? AND ?
    ORDER BY ABS(ts - ?) ASC
    LIMIT 1
  `)
    .get(
      ...routes,
      target - windowMs,
      target + windowMs,
      bbox.south,
      bbox.north,
      bbox.west,
      bbox.east,
      target,
    );
  return row?.ts ?? null;
}

function loadBuses(routes, bbox, ts) {
  const placeholders = routes.map(() => '?').join(',');
  return getDb()
    .prepare(`
    SELECT route, direction AS pid, vehicle_id AS vid, lat, lon
    FROM observations
    WHERE kind = 'bus'
      AND route IN (${placeholders})
      AND ts = ?
      AND lat BETWEEN ? AND ?
      AND lon BETWEEN ? AND ?
  `)
    .all(...routes, ts, bbox.south, bbox.north, bbox.west, bbox.east);
}

function loadPattern(pid) {
  const p = Path.join(__dirname, '..', 'data', 'patterns', `${pid}.json`);
  return JSON.parse(Fs.readFileSync(p, 'utf8'));
}

// Project bus onto its pattern's nearest segment so the marker sits on the
// route line instead of at the noisy GPS report.
function snapToPattern(bus, pattern) {
  const pts = pattern.points;
  let best = { dist: Infinity, lat: bus.lat, lon: bus.lon };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i],
      b = pts[i + 1];
    const dx = b.lon - a.lon,
      dy = b.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((bus.lon - a.lon) * dx + (bus.lat - a.lat) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const sx = a.lon + t * dx,
      sy = a.lat + t * dy;
    const d = haversineFt(bus, { lat: sy, lon: sx });
    if (d < best.dist) best = { dist: d, lat: sy, lon: sx };
  }
  return best;
}

function clipPattern(points, bbox) {
  const out = [];
  let cur = [];
  for (const p of points) {
    const inBox =
      p.lat >= bbox.south && p.lat <= bbox.north && p.lon >= bbox.west && p.lon <= bbox.east;
    if (inBox) cur.push([p.lat, p.lon]);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function decimate(seg, maxPoints = 60) {
  if (seg.length <= maxPoints) return seg;
  const step = Math.max(1, Math.floor(seg.length / maxPoints));
  const sampled = seg.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== seg[seg.length - 1]) sampled.push(seg[seg.length - 1]);
  return sampled;
}

async function main() {
  const args = parseArgs();
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const bbox = bboxForCenter(args.center, args.radius);

  // Resolve target snapshot ts.
  let ts;
  if (args.peakBetween) {
    ts = findPeakSnapshot(args.routes, bbox, args.peakBetween.start, args.peakBetween.end);
    if (!ts) throw new Error('No snapshots in --peak-between window with buses in bbox');
    console.log(`Peak snapshot: ${new Date(ts).toISOString()} (ts=${ts})`);
  } else {
    ts = findSnapshotNear(args.routes, bbox, args.at);
    if (!ts) throw new Error('No snapshot near --at within ±120s with buses in bbox');
    console.log(`Snapshot: ${new Date(ts).toISOString()} (ts=${ts})`);
  }

  const buses = loadBuses(args.routes, bbox, ts);
  if (!buses.length) throw new Error('No buses in bbox at chosen snapshot');
  console.log(
    `${buses.length} buses across routes: ${[...new Set(buses.map((b) => b.route))].join(', ')}`,
  );

  // Snap each bus to its pattern.
  const patternCache = new Map();
  const snapped = buses.map((b) => {
    if (!b.pid) return { ...b, snap: { lat: b.lat, lon: b.lon } };
    if (!patternCache.has(b.pid)) {
      try {
        patternCache.set(b.pid, loadPattern(b.pid));
      } catch {
        patternCache.set(b.pid, null);
      }
    }
    const pat = patternCache.get(b.pid);
    const snap = pat ? snapToPattern(b, pat) : { lat: b.lat, lon: b.lon };
    return { ...b, snap };
  });

  // Build polyline overlays for every distinct pid present, clipped to bbox.
  const routeColor = {};
  args.routes.forEach((r, i) => {
    routeColor[r] = colorForRoute(r, i);
  });

  const overlays = [];
  for (const [pid, pat] of patternCache.entries()) {
    if (!pat) continue;
    // Find route via any bus that uses this pid (pattern files don't store rt).
    const owner = snapped.find((b) => b.pid === pid)?.route;
    if (!owner) continue;
    const color = routeColor[owner];
    for (const seg of clipPattern(pat.points, bbox)) {
      if (seg.length < 2) continue;
      const enc = encodeURIComponent(encode(decimate(seg), 5));
      overlays.push(`path-5+${color}-1(${enc})`);
    }
  }

  // Fetch basemap.
  const url = `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${overlays.join(',')}/${args.center.lon},${args.center.lat},${args.zoom}/${args.width}x${args.height}@2x?access_token=${token}`;
  if (url.length > 8100) {
    console.warn(
      `Mapbox URL is ${url.length} chars; consider tighter --radius or fewer routes if this 4xxs.`,
    );
  }
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30_000 });
  const baseMap = Buffer.from(r.data);

  // SVG overlay sized to physical pixels (Mapbox @2x).
  const SCALE = 2;
  const physW = args.width * SCALE,
    physH = args.height * SCALE;
  const RADIUS = 34; // matches BUS_MARKER_RADIUS in bunching/gaps maps
  const MIN_DIST = RADIUS * 2 + 4;

  const toPx = (lat, lon) => {
    const p = project(
      lat,
      lon,
      args.center.lat,
      args.center.lon,
      args.zoom,
      args.width,
      args.height,
    );
    return { x: p.x * SCALE, y: p.y * SCALE };
  };

  const rawMarkers = snapped.map((b) => {
    const { x, y } = toPx(b.snap.lat, b.snap.lon);
    return { bus: b, x, y };
  });
  const separated = separateMarkers(rawMarkers, MIN_DIST);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${physW}" height="${physH}" viewBox="0 0 ${physW} ${physH}">`,
  ];

  for (const { bus, x, y } of separated) {
    svg.push(
      buildBusMarker({
        x,
        y,
        radius: RADIUS,
        color: routeColor[bus.route],
        articulated: isArticulated(bus.vid),
      }),
    );
  }

  // Vehicle labels above markers, with collision-resolve so stacks read.
  const fontSize = 22;
  const padX = 6,
    padY = 3;
  const labels = await Promise.all(
    separated.map(async ({ bus, x, y }) => ({
      bus,
      x,
      y: y - RADIUS - 6,
      txt: `#${bus.vid}`,
      textW: await measureTextWidth(`#${bus.vid}`, fontSize, { bold: true }),
    })),
  );
  const rects = labels.map((l) => ({
    x: l.x,
    y: l.y,
    w: l.textW + 2 * padX,
    h: fontSize + 2 * padY,
  }));
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i],
          b = rects[j];
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2) {
          const push = ((a.h + b.h) / 2 - Math.abs(a.y - b.y)) / 2 + 1;
          if (a.y <= b.y) {
            a.y -= push;
            b.y += push;
          } else {
            a.y += push;
            b.y -= push;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    const { x: lx, y: ly } = rects[i];
    svg.push(
      `<rect x="${lx - l.textW / 2 - padX}" y="${ly - fontSize / 2 - padY}" width="${l.textW + 2 * padX}" height="${fontSize + 2 * padY}" rx="4" fill="rgba(0,0,0,0.82)"/>`,
      `<text x="${lx}" y="${ly + fontSize / 2 - 4}" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle">${l.txt}</text>`,
    );
  }

  // Legend (top-left): timestamp on top, then per-route counts.
  const counts = {};
  for (const b of snapped) counts[b.route] = (counts[b.route] || 0) + 1;
  // Stable order: as user supplied --routes, but only those present.
  const order = args.routes.filter((r) => counts[r]);
  const tsStr =
    new Date(ts)
      .toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      .replace(',', '') + ' CDT';
  const tsFs = 22,
    legendFs = 24,
    lineH = 36,
    dotR = 12,
    dotGap = 12;
  const legendTexts = order.map((r) => `${r} ${nameForRoute(r)} — ${counts[r]} buses`);
  const legendTextWs = await Promise.all(
    legendTexts.map((t) => measureTextWidth(t, legendFs, { bold: true })),
  );
  const tsTextW = await measureTextWidth(tsStr, tsFs, { bold: true });
  const padL = 16,
    padR = 18,
    padV = 14;
  const innerRoutesW = Math.max(...legendTextWs) + dotR * 2 + dotGap;
  const legendW = padL + Math.max(innerRoutesW, tsTextW) + padR;
  const tsBlockH = tsFs + 10;
  const legendH = padV * 2 + tsBlockH + lineH * order.length - (lineH - legendFs);
  const lx0 = 28,
    ly0 = 28;
  svg.push(
    `<rect x="${lx0}" y="${ly0}" width="${legendW}" height="${legendH}" rx="8" fill="rgba(0,0,0,0.82)"/>`,
  );
  svg.push(
    `<text x="${lx0 + padL}" y="${ly0 + padV + tsFs - 2}" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${tsFs}" font-weight="600">${xmlEscape(tsStr)}</text>`,
  );
  order.forEach((rid, i) => {
    const yy = ly0 + padV + tsBlockH + legendFs + i * lineH;
    svg.push(
      `<circle cx="${lx0 + padL + dotR}" cy="${yy - legendFs / 2 + 2}" r="${dotR}" fill="#${routeColor[rid]}" stroke="#fff" stroke-width="2.5"/>`,
      `<text x="${lx0 + padL + dotR * 2 + dotGap}" y="${yy}" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${legendFs}" font-weight="600">${xmlEscape(legendTexts[i])}</text>`,
    );
  });

  // Intersection label, centered on the supplied --center.
  const ip = toPx(args.center.lat, args.center.lon);
  const intrFs = 26;
  const intrTextW = await measureTextWidth(args.label, intrFs, { bold: true });
  const intrBoxW = intrTextW + 20;
  const intrBoxH = intrFs + 12;
  const intrBoxY = ip.y + 60 - intrFs / 2 - 6;
  svg.push(
    `<rect x="${ip.x - intrBoxW / 2}" y="${intrBoxY}" width="${intrBoxW}" height="${intrBoxH}" rx="6" fill="rgba(0,0,0,0.85)"/>`,
    `<text x="${ip.x}" y="${ip.y + 60 + intrFs / 2 - 4}" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${intrFs}" font-weight="700" text-anchor="middle">${xmlEscape(args.label)}</text>`,
  );

  svg.push('</svg>');

  const png = await sharp(baseMap)
    .composite([{ input: Buffer.from(svg.join('')), top: 0, left: 0 }])
    .png()
    .toBuffer();

  Fs.mkdirSync(Path.dirname(args.out), { recursive: true });
  Fs.writeFileSync(args.out, png);
  console.log(`Wrote ${args.out}`);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
