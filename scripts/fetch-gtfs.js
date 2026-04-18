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

// Restrict indexing to bus routes the bot actually polls. Keeps the index
// small and skips rail routes we don't gap-check yet.
const { bunching: BUS_ROUTES } = require('../src/routes');

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
  const serviceDayType = new Map();
  for (const c of calendars) {
    const dt = dayTypeFor(c);
    if (dt) serviceDayType.set(c.service_id, dt);
  }
  console.log(`  ${serviceDayType.size} service_ids mapped to day types`);

  console.log('Reading trips.txt...');
  const trips = parseCsv(await readFromZip('trips.txt'));
  const busRouteSet = new Set(BUS_ROUTES);
  // tripMeta: trip_id → { route, dir, dayType, headsign }
  const tripMeta = new Map();
  for (const t of trips) {
    if (!busRouteSet.has(t.route_id)) continue;
    const dt = serviceDayType.get(t.service_id);
    if (!dt) continue;
    tripMeta.set(t.trip_id, {
      route: t.route_id,
      dir: t.direction_id,
      dayType: dt,
      serviceId: t.service_id,
      headsign: t.trip_headsign || t.direction || '',
    });
  }
  console.log(`  ${tripMeta.size} bus trips in scope`);

  console.log('Streaming stop_times.txt...');
  // Per trip, track first-stop departure time (stop_sequence === min) and
  // last-stop id (stop_sequence === max).
  const firstDeparture = new Map(); // trip_id → seconds
  const firstSeq = new Map();
  const lastStopId = new Map();    // trip_id → stop_id
  const lastSeq = new Map();

  let header = null;
  let tripIdIdx = -1;
  let stopIdIdx = -1;
  let depIdx = -1;
  let seqIdx = -1;
  await streamFromZip('stop_times.txt', (line) => {
    if (!header) {
      header = line.split(',').map((s) => s.replace(/"/g, '').trim());
      tripIdIdx = header.indexOf('trip_id');
      stopIdIdx = header.indexOf('stop_id');
      depIdx = header.indexOf('departure_time');
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
    }
  });
  console.log(`  first/last stop times captured for ${firstDeparture.size} trips`);

  console.log('Reading stops.txt...');
  const stops = parseCsv(await readFromZip('stops.txt'));
  const byStopId = new Map(stops.map((s) => [s.stop_id, s]));

  // CTA ships several overlapping service_ids per day_type (e.g. 67701, 67801,
  // 109001 all serve Mon–Fri over different date ranges). Merging all of them
  // into one bucket triple-counts the same schedule and collapses gaps to 0.
  // Pick the dominant service_id — the one with the most trips for each
  // (route, dir, dayType) — as a proxy for "the regular schedule" and ignore
  // the rest.
  const serviceTripCounts = new Map(); // key: route|dir|dayType|serviceId → count
  for (const meta of tripMeta.values()) {
    const k = `${meta.route}|${meta.dir}|${meta.dayType}|${meta.serviceId}`;
    serviceTripCounts.set(k, (serviceTripCounts.get(k) || 0) + 1);
  }
  const dominantService = new Map(); // key: route|dir|dayType → serviceId
  for (const [k, c] of serviceTripCounts) {
    const [route, dir, dayType, serviceId] = k.split('|');
    const rdt = `${route}|${dir}|${dayType}`;
    const prev = dominantService.get(rdt);
    if (!prev || c > prev.count) dominantService.set(rdt, { serviceId, count: c });
  }

  const buckets = new Map();
  function bucketKey(route, dir, dayType, hour) {
    return `${route}|${dir}|${dayType}|${hour}`;
  }
  const lastStopSample = new Map();

  for (const [tripId, meta] of tripMeta) {
    const dominant = dominantService.get(`${meta.route}|${meta.dir}|${meta.dayType}`);
    if (!dominant || dominant.serviceId !== meta.serviceId) continue;
    const dep = firstDeparture.get(tripId);
    if (dep == null) continue;
    const hour = Math.floor(dep / 3600) % 24;
    const key = bucketKey(meta.route, meta.dir, meta.dayType, hour);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(dep);

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

  // For each bucket, compute median of consecutive departure gaps (minutes).
  const out = { generatedAt: Date.now(), routes: {} };
  for (const [key, times] of buckets) {
    if (times.length < 2) continue;
    const [route, dir, dayType, hourStr] = key.split('|');
    const hour = parseInt(hourStr, 10);
    const sorted = [...times].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 60);
    const medMin = median(gaps);
    if (medMin == null) continue;
    if (!out.routes[route]) out.routes[route] = {};
    if (!out.routes[route][dir]) {
      const sample = lastStopSample.get(`${route}|${dir}`) || {};
      out.routes[route][dir] = {
        headsign: sample.headsign || '',
        terminalLat: sample.lat ?? null,
        terminalLon: sample.lon ?? null,
        headways: {},
      };
    }
    if (!out.routes[route][dir].headways[dayType]) out.routes[route][dir].headways[dayType] = {};
    out.routes[route][dir].headways[dayType][hour] = Math.round(medMin * 10) / 10;
  }

  Fs.ensureDirSync(Path.dirname(OUT_PATH));
  Fs.writeJsonSync(OUT_PATH, out);
  const bytes = Fs.statSync(OUT_PATH).size;
  const routeCount = Object.keys(out.routes).length;
  console.log(`Wrote ${OUT_PATH} (${(bytes / 1024).toFixed(1)} KB, ${routeCount} routes)`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
