const Path = require('path');
const Fs = require('fs-extra');
const { haversineFt } = require('./geo');

const INDEX_PATH = Path.join(__dirname, '..', '..', 'data', 'gtfs', 'index.json');
const STALE_MS = 30 * 24 * 60 * 60 * 1000; // warn-only: index older than 30d is probably out of date

let _index = null;

function loadIndex() {
  if (_index) return _index;
  if (!Fs.existsSync(INDEX_PATH)) {
    throw new Error(`GTFS index not found at ${INDEX_PATH}. Run: node scripts/fetch-gtfs.js`);
  }
  _index = Fs.readJsonSync(INDEX_PATH);
  const age = Date.now() - (_index.generatedAt || 0);
  if (age > STALE_MS) {
    console.warn(`GTFS index is ${Math.round(age / (24 * 60 * 60 * 1000))} days old — consider re-running fetch-gtfs.js`);
  }
  return _index;
}

// Day-type bucket for a given instant in Chicago time. Matches the keys
// produced by fetch-gtfs.js (weekday/saturday/sunday/weekend).
function dayTypeFor(now = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(now);
  if (weekday === 'Sat') return 'saturday';
  if (weekday === 'Sun') return 'sunday';
  return 'weekday';
}

function chicagoHour(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }).format(now);
  return parseInt(h, 10);
}

// Service-day transition is fuzzy around 4 AM: CTA encodes a trip that runs
// at 1:15 AM Sunday as "25:15:00" under Saturday's service_id, so at 1 AM
// Sunday wall-clock the right bucket is Saturday's. We always consult both
// yesterday's and today's dayType — the only question is which to prefer.
// Before 4 AM: prefer prior (today's service hasn't really started).
// After 4 AM: prefer today (but fall back to prior if today has no entry and
// yesterday's service is still running mid-route).
const LATE_NIGHT_CUTOFF_HOUR = 4;

// Resolve an hourly value from a {dayType: {hour: value}} map. Returns null
// if neither today's nor yesterday's bucket has an entry for the current hour
// — that means "no scheduled service," which callers should treat as "skip,"
// not "interpolate from another hour."
function hourlyLookup(byDayType, now) {
  if (!byDayType) return null;
  const hour = chicagoHour(now);
  const todayDt = dayTypeFor(now);
  const priorDt = dayTypeFor(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  const candidates = hour < LATE_NIGHT_CUTOFF_HOUR ? [priorDt, todayDt] : [todayDt, priorDt];
  if (candidates.some((dt) => dt === 'saturday' || dt === 'sunday')) candidates.push('weekend');

  for (const dt of candidates) {
    const byHour = byDayType[dt];
    if (byHour && byHour[hour] != null) return byHour[hour];
  }
  return null;
}

/**
 * Resolve a pattern to a GTFS direction_id ("0" or "1") by comparing the
 * pattern's last point (the route's end terminal) to each direction's last
 * stop from GTFS. Returns null if the route isn't indexed or if no terminal
 * data exists. Cached by pid since pattern geometry rarely changes.
 */
const _directionCache = new Map();
function resolveDirection(pattern) {
  // Cache positive hits only. Caching null would freeze a "missing route"
  // lookup forever, so a route added to a freshly regenerated index would
  // never resolve in a long-running process.
  const cached = _directionCache.get(pattern.pid);
  if (cached) return cached;
  const index = loadIndex();
  const byDir = index.routes[pattern.route];
  if (!byDir) return null;
  const end = pattern.points[pattern.points.length - 1];
  let best = null;
  let bestDist = Infinity;
  for (const dir of ['0', '1']) {
    const info = byDir[dir];
    if (!info || info.terminalLat == null) continue;
    const d = haversineFt({ lat: info.terminalLat, lon: info.terminalLon }, end);
    if (d < bestDist) {
      bestDist = d;
      best = dir;
    }
  }
  if (best) _directionCache.set(pattern.pid, best);
  return best;
}

// Resolve the directional bucket of an indexed bus route, then pull `field`
// (`headways` or `durations`) and look it up by hour. Single source of truth
// for both `expectedHeadwayMin` and `expectedTripMinutes`.
function busLookup(route, pattern, field, now) {
  const index = loadIndex();
  const byDir = index.routes[route];
  if (!byDir) return null;
  const dir = resolveDirection({ ...pattern, route });
  if (!dir) return null;
  const dirInfo = byDir[dir];
  if (!dirInfo || !dirInfo[field]) return null;
  return hourlyLookup(dirInfo[field], now);
}

function expectedHeadwayMin(route, pattern, now = new Date()) {
  return busLookup(route, pattern, 'headways', now);
}

function expectedTripMinutes(route, pattern, now = new Date()) {
  return busLookup(route, pattern, 'durations', now);
}

// Train Tracker line codes (lowercase) → GTFS route_id in the index. These
// are the only eight rail "routes" CTA publishes and the mapping is static.
const TRAIN_LINE_TO_GTFS = {
  red: 'Red', blue: 'Blue', brn: 'Brn', g: 'G',
  org: 'Org', p: 'P', pink: 'Pink', y: 'Y',
};

// Pick the GTFS direction whose terminal is closest to `destination` ({lat,
// lon}). Loop lines (Brown/Orange/Purple/Pink/Yellow) ship one direction so
// the match is trivial.
function pickTrainDirInfo(line, destination) {
  const index = loadIndex();
  const gtfsId = TRAIN_LINE_TO_GTFS[line];
  if (!gtfsId) return null;
  const byDir = index.lines && index.lines[gtfsId];
  if (!byDir) return null;
  const dirs = Object.values(byDir);
  if (dirs.length === 1) return dirs[0];
  if (!destination || destination.lat == null) return null;
  let best = null;
  let bestDist = Infinity;
  for (const info of dirs) {
    if (info.terminalLat == null) continue;
    const d = haversineFt({ lat: info.terminalLat, lon: info.terminalLon }, destination);
    if (d < bestDist) { bestDist = d; best = info; }
  }
  return best;
}

function trainLookup(line, destination, field, now) {
  const dirInfo = pickTrainDirInfo(line, destination);
  if (!dirInfo || !dirInfo[field]) return null;
  return hourlyLookup(dirInfo[field], now);
}

function expectedTrainHeadwayMin(line, destination, now = new Date()) {
  return trainLookup(line, destination, 'headways', now);
}

function expectedTrainTripMinutes(line, destination, now = new Date()) {
  return trainLookup(line, destination, 'durations', now);
}

// Loop lines (Brown/Orange/Pink/Purple/Yellow) ship a single GTFS direction_id
// covering the full Midway→Loop→Midway round trip. Bi-directional lines
// (Red/Blue/Green) have two. Ghost detection uses this to decide whether to
// split observations by Train Tracker direction or aggregate line-wide.
function isTrainLoopLine(line) {
  const index = loadIndex();
  const gtfsId = TRAIN_LINE_TO_GTFS[line];
  if (!gtfsId) return false;
  const byDir = index.lines && index.lines[gtfsId];
  if (!byDir) return false;
  return Object.keys(byDir).length === 1;
}

module.exports = { loadIndex, expectedHeadwayMin, expectedTrainHeadwayMin, expectedTripMinutes, expectedTrainTripMinutes, isTrainLoopLine, resolveDirection, dayTypeFor, chicagoHour, hourlyLookup };
