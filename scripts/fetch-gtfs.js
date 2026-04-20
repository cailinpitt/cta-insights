// Fetch CTA GTFS schedule and build a headway index for gap detection.
// Run weekly via cron; bot runtime reads the precomputed index so it doesn't
// pay the parse cost on every invocation.
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

// Restrict bus indexing to the routes the bot actually polls. Keeps the
// index small. Rail indexing is always all-lines — there are only eight.
const { bunching: BUS_ROUTES } = require('../src/bus/routes');
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

// RFC 4180-aware CSV parser. Needed because stops.txt contains quoted
// stop_desc fields with embedded commas ("Touhy & Lehigh, Eastbound, ...").
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

// GTFS time fields can exceed 24h (e.g. "25:15:00" = 1:15am next day). Return
// seconds since service-day start; caller mods by 86400 to get wall-clock hour.
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

// Map a GTFS calendar.txt row to a coarse day_type bucket. Weekday service is
// the common weekday pattern; we collapse Sat/Sun separately since headways
// differ by a lot between weekends and weekdays.
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

async function main() {
  await downloadGtfs();

  console.log('Reading calendar.txt...');
  const calendars = parseCsv(await readFromZip('calendar.txt'));
  // Restrict to service_ids whose date range covers today. CTA ships seasonal
  // duplicates (e.g. 67708 for 3/20–3/28 + 67808 for 3/29–5/31 — same Sunday
  // schedule, different windows). Only one applies on any given date; keeping
  // both would double-count trips in the hour buckets below.
  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const serviceDayType = new Map();
  for (const c of calendars) {
    const dt = dayTypeFor(c);
    if (!dt) continue;
    if (todayStr < c.start_date || todayStr > c.end_date) continue;
    serviceDayType.set(c.service_id, dt);
  }
  console.log(`  ${serviceDayType.size} service_ids active on ${todayStr} mapped to day types`);

  console.log('Reading trips.txt...');
  const trips = parseCsv(await readFromZip('trips.txt'));
  const busRouteSet = new Set(BUS_ROUTES);
  const railRouteSet = new Set(RAIL_ROUTES);
  // tripMeta: trip_id → { route, dir, dayType, headsign, mode }
  // mode: 'bus' or 'rail'. Drives which output bucket (`routes` vs `lines`)
  // the eventual headway lands in.
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
  // Per trip, track first-stop departure time (stop_sequence === min) and
  // last-stop id (stop_sequence === max).
  const firstDeparture = new Map(); // trip_id → seconds
  const firstSeq = new Map();
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

  // Even after the calendar-date filter, a single dayType can be served by
  // multiple concurrent service_ids — most often a daytime service_id covering
  // 4 AM–1 AM plus a separate "Owl" service_id covering overnight hours.
  // Resolve dominance *per hour* so daytime hours pick the daytime service
  // (owl has 0 trips there) and overnight hours pick the owl service.
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

  const buckets = new Map();
  // Parallel bucket keyed the same way as `buckets`, storing per-trip durations
  // (minutes) so ghost detection can compare observed active vehicle counts to
  // `duration / headway`.
  const durationBuckets = new Map();
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
    const key = bucketKey(meta.route, meta.dir, meta.dayType, hour);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(dep);

    const arr = lastArrival.get(tripId);
    if (arr != null && arr > dep) {
      const durMin = (arr - dep) / 60;
      if (!durationBuckets.has(key)) durationBuckets.set(key, []);
      durationBuckets.get(key).push(durMin);
    }

    const rdKey = `${meta.route}|${meta.dir}`;
    if (!lastStopSample.has(rdKey)) {
      const stopId = lastStopId.get(tripId);
      const stop = stopId && byStopId.get(stopId);
      if (stop) {
        lastStopSample.set(rdKey, {
          lat: parseFloat(stop.stop_lat),
          lon: parseFloat(stop.stop_lon),
          headsign: meta.headsign,
        });
      }
    }
  }

  // Bucket keys are mode-agnostic; split into routes (bus) vs lines (rail)
  // at output time so the runtime lookup can key on whichever makes sense.
  const routeMode = new Map(); // route_id → 'bus' | 'rail' (derived from tripMeta)
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

  Fs.ensureDirSync(Path.dirname(OUT_PATH));
  Fs.writeJsonSync(OUT_PATH, out);
  const bytes = Fs.statSync(OUT_PATH).size;
  const routeCount = Object.keys(out.routes).length;
  const lineCount = Object.keys(out.lines).length;
  console.log(`Wrote ${OUT_PATH} (${(bytes / 1024).toFixed(1)} KB, ${routeCount} bus routes, ${lineCount} rail lines)`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
