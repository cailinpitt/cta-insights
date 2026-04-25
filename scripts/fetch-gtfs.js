// Builds a headway index for gap detection. Bot runtime reads the precomputed
// JSON so it doesn't re-parse GTFS on every invocation.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const Fs = require('fs-extra');
const Path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const readline = require('readline');

const execAsync = promisify(exec);

const GTFS_URL = 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip';
const ZIP_PATH = '/tmp/cta-gtfs.zip';
const OUT_PATH = Path.join(__dirname, '..', 'data', 'gtfs', 'index.json');

// Union of all polled lists — a route in ghosts/gaps but not bunching would
// otherwise silently have no schedule. Rail is always all 8 lines.
const { bunching, ghosts, gaps, speedmap } = require('../src/bus/routes');
const BUS_ROUTES = [...new Set([...bunching, ...ghosts, ...gaps, ...speedmap])].sort();
const RAIL_ROUTES = ['Red', 'Blue', 'Brn', 'G', 'Org', 'P', 'Pink', 'Y'];

async function downloadGtfs() {
  if (Fs.existsSync(ZIP_PATH)) {
    const age = Date.now() - Fs.statSync(ZIP_PATH).mtimeMs;
    if (age < 24 * 60 * 60 * 1000) {
      console.log('Using cached GTFS zip (< 1 day old)');
      return;
    }
  }
  console.log(`Downloading GTFS from ${GTFS_URL}...`);
  const resp = await axios.get(GTFS_URL, { responseType: 'arraybuffer', timeout: 120000 });
  Fs.writeFileSync(ZIP_PATH, resp.data);
  console.log(`  ${(resp.data.length / 1024 / 1024).toFixed(1)} MB`);
}

async function readFromZip(filename) {
  const { stdout } = await execAsync(`unzip -p "${ZIP_PATH}" "${filename}"`, { maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

function streamFromZip(filename, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-p', ZIP_PATH, filename]);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', onLine);
    rl.on('close', resolve);
    proc.on('error', reject);
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
}

// RFC 4180-aware — stops.txt has quoted fields with embedded commas.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = parts[j];
    rows.push(row);
  }
  return rows;
}

// GTFS times can exceed 24h ("25:15:00" = 1:15am next day). Caller mods by 86400.
function parseGtfsTime(s) {
  if (!s) return null;
  const [h, m, sec] = s.split(':').map((x) => parseInt(x, 10));
  return h * 3600 + m * 60 + (sec || 0);
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Coarse day_type bucket — Sat/Sun stay separate since headways differ a lot.
function dayTypeFor(cal) {
  const weekday = cal.monday === '1' && cal.tuesday === '1' && cal.wednesday === '1' && cal.thursday === '1' && cal.friday === '1';
  const sat = cal.saturday === '1';
  const sun = cal.sunday === '1';
  if (weekday && !sat && !sun) return 'weekday';
  if (!weekday && sat && !sun) return 'saturday';
  if (!weekday && !sat && sun) return 'sunday';
  if (sat && sun && !weekday) return 'weekend';
  return null; // mixed/unusual services — skip so we don't mash weekday + weekend headways together
}

// Honors calendar.txt date ranges + calendar_dates.txt exceptions for today.
function resolveServiceDayTypes({ calendars, calendarDates, todayStr, todayDow }) {
  const addForToday = new Set();
  const removeForToday = new Set();
  for (const r of calendarDates) {
    if (r.date !== todayStr) continue;
    if (r.exception_type === '1') addForToday.add(r.service_id);
    else if (r.exception_type === '2') removeForToday.add(r.service_id);
  }
  const out = new Map();
  for (const c of calendars) {
    const dt = dayTypeFor(c);
    if (!dt) continue;
    if (todayStr < c.start_date || todayStr > c.end_date) continue;
    if (removeForToday.has(c.service_id)) continue;
    out.set(c.service_id, dt);
  }
  if (addForToday.size) {
    const fallbackDt = todayDow === 'Sat' ? 'saturday' : todayDow === 'Sun' ? 'sunday' : 'weekday';
    for (const sid of addForToday) {
      if (!out.has(sid)) out.set(sid, fallbackDt);
    }
  }
  return { serviceDayType: out, addForToday, removeForToday };
}

// Day-level dominance, not per-hour: per-hour was too aggressive for Route 55
// at 2 AM. ≥60% threshold means short-turn-only periods keep all origins.
const BUS_DOMINANCE_THRESHOLD = 0.6;
function computeBusDominantOrigin(tripMeta, firstStopId, { log = false } = {}) {
  const counts = new Map();
  for (const [tripId, meta] of tripMeta) {
    if (meta.mode !== 'bus') continue;
    const origin = firstStopId.get(tripId);
    if (!origin) continue;
    const k = `${meta.route}|${meta.dir}`;
    if (!counts.has(k)) counts.set(k, new Map());
    const m = counts.get(k);
    m.set(origin, (m.get(origin) || 0) + 1);
  }
  const dominant = new Map();
  for (const [k, c] of counts) {
    let best = null;
    let bestCount = -1;
    let total = 0;
    for (const [stopId, n] of c) {
      total += n;
      if (n > bestCount) { bestCount = n; best = stopId; }
    }
    if (best && bestCount / total >= BUS_DOMINANCE_THRESHOLD) {
      dominant.set(k, best);
    } else if (log) {
      console.log(`bus ${k}: no dominant origin (top=${bestCount}/${total}, ${c.size} origins) — keeping all`);
    }
  }
  return dominant;
}

async function main() {
  console.log(`Indexing ${BUS_ROUTES.length} bus routes: ${BUS_ROUTES.join(', ')}`);
  await downloadGtfs();

  console.log('Reading calendar.txt...');
  const calendars = parseCsv(await readFromZip('calendar.txt'));
  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

  // Holiday service: exception_type=1 force-adds, =2 force-removes. Without
  // this, holidays (Memorial Day, Thanksgiving) ghost-fire en masse.
  console.log('Reading calendar_dates.txt...');
  let calendarDates = [];
  try {
    calendarDates = parseCsv(await readFromZip('calendar_dates.txt'));
  } catch (e) {
    console.warn(`  could not read calendar_dates.txt: ${e.message} — proceeding without exceptions`);
  }
  const todayDow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(today);
  const { serviceDayType, addForToday, removeForToday } = resolveServiceDayTypes({ calendars, calendarDates, todayStr, todayDow });
  console.log(`  ${serviceDayType.size} service_ids active on ${todayStr} (+${addForToday.size} added / -${removeForToday.size} removed via calendar_dates)`);

  console.log('Reading trips.txt...');
  const trips = parseCsv(await readFromZip('trips.txt'));
  const busRouteSet = new Set(BUS_ROUTES);
  const railRouteSet = new Set(RAIL_ROUTES);
  // tripMeta.mode (bus|rail) routes results to `routes` or `lines` output bucket.
  const tripMeta = new Map();
  for (const t of trips) {
    let mode = null;
    if (busRouteSet.has(t.route_id)) mode = 'bus';
    else if (railRouteSet.has(t.route_id)) mode = 'rail';
    if (!mode) continue;
    const dt = serviceDayType.get(t.service_id);
    if (!dt) continue;
    tripMeta.set(t.trip_id, {
      route: t.route_id,
      dir: t.direction_id,
      dayType: dt,
      serviceId: t.service_id,
      headsign: t.trip_headsign || t.direction || '',
      mode,
    });
  }
  const busCount = [...tripMeta.values()].filter((m) => m.mode === 'bus').length;
  const railCount = tripMeta.size - busCount;
  console.log(`  ${busCount} bus trips, ${railCount} rail trips in scope`);

  console.log('Streaming stop_times.txt...');
  // Per trip: first-stop departure (min stop_sequence) and last-stop id (max).
  const firstDeparture = new Map(); // trip_id → seconds
  const firstSeq = new Map();
  const firstStopId = new Map();   // trip_id → stop_id (origin)
  const lastStopId = new Map();    // trip_id → stop_id
  const lastArrival = new Map();   // trip_id → seconds (last-stop arrival)
  const lastSeq = new Map();

  let header = null;
  let tripIdIdx = -1;
  let stopIdIdx = -1;
  let depIdx = -1;
  let arrIdx = -1;
  let seqIdx = -1;
  await streamFromZip('stop_times.txt', (line) => {
    if (!header) {
      header = line.split(',').map((s) => s.replace(/"/g, '').trim());
      tripIdIdx = header.indexOf('trip_id');
      stopIdIdx = header.indexOf('stop_id');
      depIdx = header.indexOf('departure_time');
      arrIdx = header.indexOf('arrival_time');
      seqIdx = header.indexOf('stop_sequence');
      return;
    }
    const parts = line.split(',');
    const tripId = parts[tripIdIdx];
    if (!tripMeta.has(tripId)) return;
    const seq = parseInt(parts[seqIdx], 10);
    const prevFirst = firstSeq.get(tripId);
    if (prevFirst === undefined || seq < prevFirst) {
      firstSeq.set(tripId, seq);
      firstDeparture.set(tripId, parseGtfsTime(parts[depIdx]));
      firstStopId.set(tripId, parts[stopIdIdx]);
    }
    const prevLast = lastSeq.get(tripId);
    if (prevLast === undefined || seq > prevLast) {
      lastSeq.set(tripId, seq);
      lastStopId.set(tripId, parts[stopIdIdx]);
      lastArrival.set(tripId, parseGtfsTime(parts[arrIdx]));
    }
  });
  console.log(`  first/last stop times captured for ${firstDeparture.size} trips`);

  console.log('Reading stops.txt...');
  const stops = parseCsv(await readFromZip('stops.txt'));
  const byStopId = new Map(stops.map((s) => [s.stop_id, s]));

  // Concurrent service_ids (daytime + Owl) overlap one dayType — resolve
  // dominance per hour so each picks the right one.
  const serviceTripCounts = new Map(); // key: route|dir|dayType|hour|serviceId → count
  for (const [tripId, meta] of tripMeta) {
    const dep = firstDeparture.get(tripId);
    if (dep == null) continue;
    const hour = Math.floor(dep / 3600) % 24;
    const k = `${meta.route}|${meta.dir}|${meta.dayType}|${hour}|${meta.serviceId}`;
    serviceTripCounts.set(k, (serviceTripCounts.get(k) || 0) + 1);
  }
  const dominantService = new Map(); // key: route|dir|dayType|hour → serviceId
  for (const [k, c] of serviceTripCounts) {
    const [route, dir, dayType, hour, serviceId] = k.split('|');
    const rdth = `${route}|${dir}|${dayType}|${hour}`;
    const prev = dominantService.get(rdth);
    if (!prev || c > prev.count) dominantService.set(rdth, { serviceId, count: c });
  }

  // Rail short-turns (UIC-Halsted, Jefferson Park) share direction_id with
  // full runs — staggering their starts collapses apparent headway. Lock on
  // dominant origin per (route, dir) to measure terminal→terminal only.
  const railOriginCounts = new Map(); // route|dir → Map(stopId → count)
  for (const [tripId, meta] of tripMeta) {
    if (meta.mode !== 'rail') continue;
    const origin = firstStopId.get(tripId);
    if (!origin) continue;
    const k = `${meta.route}|${meta.dir}`;
    if (!railOriginCounts.has(k)) railOriginCounts.set(k, new Map());
    const m = railOriginCounts.get(k);
    m.set(origin, (m.get(origin) || 0) + 1);
  }
  const railDominantOrigin = new Map(); // route|dir → stop_id
  for (const [k, counts] of railOriginCounts) {
    let best = null;
    let bestCount = -1;
    for (const [stopId, c] of counts) {
      if (c > bestCount) { bestCount = c; best = stopId; }
    }
    if (best) railDominantOrigin.set(k, best);
  }

  // Same logic for buses: garage pullouts staggered with revenue trips
  // collapse the headway median below rider-facing frequency.
  const busDominantOrigin = computeBusDominantOrigin(tripMeta, firstStopId, { log: true });

  const buckets = new Map();
  // Parallel to `buckets`, kept for display ("every ~X min").
  const durationBuckets = new Map();
  // Ground-truth: count of trips whose [dep, arr] overlaps each hour.
  // Replaces the old `duration / headway` approximation that broke during ramp-up.
  const activeBuckets = new Map();
  function bucketKey(route, dir, dayType, hour) {
    return `${route}|${dir}|${dayType}|${hour}`;
  }
  const lastStopSample = new Map();

  for (const [tripId, meta] of tripMeta) {
    const dep = firstDeparture.get(tripId);
    if (dep == null) continue;
    const hour = Math.floor(dep / 3600) % 24;
    const rdth = `${meta.route}|${meta.dir}|${meta.dayType}|${hour}`;
    const dominant = dominantService.get(rdth);
    if (!dominant || dominant.serviceId !== meta.serviceId) continue;
    if (meta.mode === 'rail') {
      const domOrigin = railDominantOrigin.get(`${meta.route}|${meta.dir}`);
      if (domOrigin && firstStopId.get(tripId) !== domOrigin) continue;
    } else if (meta.mode === 'bus') {
      const domOrigin = busDominantOrigin.get(`${meta.route}|${meta.dir}`);
      if (domOrigin && firstStopId.get(tripId) !== domOrigin) continue;
    }
    const key = bucketKey(meta.route, meta.dir, meta.dayType, hour);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(dep);

    const arr = lastArrival.get(tripId);
    if (arr != null && arr > dep) {
      const durMin = (arr - dep) / 60;
      if (!durationBuckets.has(key)) durationBuckets.set(key, []);
      durationBuckets.get(key).push(durMin);

      // Mean simultaneously-active count: weight each hour by the fraction
      // the trip spent in progress. Naive +1 per overlapping hour conflates
      // "appeared at any point" with "simultaneously in service."
      const startHour = Math.floor(dep / 3600);
      const endHour = Math.floor((arr - 1) / 3600);
      for (let h = startHour; h <= endHour; h++) {
        const hStart = h * 3600;
        const hEnd = hStart + 3600;
        const overlap = Math.min(arr, hEnd) - Math.max(dep, hStart);
        if (overlap <= 0) continue;
        const k = bucketKey(meta.route, meta.dir, meta.dayType, h % 24);
        activeBuckets.set(k, (activeBuckets.get(k) || 0) + overlap / 3600);
      }
    }

    const rdKey = `${meta.route}|${meta.dir}`;
    if (!lastStopSample.has(rdKey)) {
      const endStopId = lastStopId.get(tripId);
      const originStopId = firstStopId.get(tripId);
      const endStop = endStopId && byStopId.get(endStopId);
      const originStop = originStopId && byStopId.get(originStopId);
      if (endStop) {
        lastStopSample.set(rdKey, {
          lat: parseFloat(endStop.stop_lat),
          lon: parseFloat(endStop.stop_lon),
          originLat: originStop ? parseFloat(originStop.stop_lat) : null,
          originLon: originStop ? parseFloat(originStop.stop_lon) : null,
          headsign: meta.headsign,
        });
      }
    }
  }

  // Bucket keys are mode-agnostic — split into routes/lines at output time.
  const routeMode = new Map();
  for (const meta of tripMeta.values()) routeMode.set(meta.route, meta.mode);

  // For each bucket, compute median of consecutive departure gaps (minutes).
  const out = { generatedAt: Date.now(), routes: {}, lines: {} };
  for (const [key, times] of buckets) {
    if (times.length < 2) continue;
    const [route, dir, dayType, hourStr] = key.split('|');
    const hour = parseInt(hourStr, 10);
    const sorted = [...times].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 60);
    const medMin = median(gaps);
    if (medMin == null) continue;
    const bucket = routeMode.get(route) === 'rail' ? out.lines : out.routes;
    if (!bucket[route]) bucket[route] = {};
    if (!bucket[route][dir]) {
      const sample = lastStopSample.get(`${route}|${dir}`) || {};
      bucket[route][dir] = {
        headsign: sample.headsign || '',
        terminalLat: sample.lat ?? null,
        terminalLon: sample.lon ?? null,
        originLat: sample.originLat ?? null,
        originLon: sample.originLon ?? null,
        headways: {},
      };
    }
    if (!bucket[route][dir].headways[dayType]) bucket[route][dir].headways[dayType] = {};
    bucket[route][dir].headways[dayType][hour] = Math.round(medMin * 10) / 10;

    const durations = durationBuckets.get(key);
    if (durations && durations.length > 0) {
      const medDur = median(durations);
      if (medDur != null) {
        if (!bucket[route][dir].durations) bucket[route][dir].durations = {};
        if (!bucket[route][dir].durations[dayType]) bucket[route][dir].durations[dayType] = {};
        bucket[route][dir].durations[dayType][hour] = Math.round(medDur * 10) / 10;
      }
    }

  }

  // Active-trip counts emit separately — hours with zero starts can still
  // have trips in progress that began earlier.
  for (const [key, count] of activeBuckets) {
    const [route, dir, dayType, hourStr] = key.split('|');
    const hour = parseInt(hourStr, 10);
    const bucket = routeMode.get(route) === 'rail' ? out.lines : out.routes;
    if (!bucket[route] || !bucket[route][dir]) continue;
    if (!bucket[route][dir].activeByHour) bucket[route][dir].activeByHour = {};
    if (!bucket[route][dir].activeByHour[dayType]) bucket[route][dir].activeByHour[dayType] = {};
    bucket[route][dir].activeByHour[dayType][hour] = Math.round(count * 10) / 10;
  }

  Fs.ensureDirSync(Path.dirname(OUT_PATH));
  Fs.writeJsonSync(OUT_PATH, out);
  const bytes = Fs.statSync(OUT_PATH).size;
  const routeCount = Object.keys(out.routes).length;
  const lineCount = Object.keys(out.lines).length;
  console.log(`Wrote ${OUT_PATH} (${(bytes / 1024).toFixed(1)} KB, ${routeCount} bus routes, ${lineCount} rail lines)`);
}

module.exports = { computeBusDominantOrigin, BUS_DOMINANCE_THRESHOLD, resolveServiceDayTypes, dayTypeFor };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}
