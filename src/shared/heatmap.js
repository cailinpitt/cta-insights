// Builds bunching heatmap data from history.sqlite. Aggregates posted
// bunching events by location (stop name for bus, station name for train)
// over a time window, resolves each to lat/lon, and returns a list of
// points sorted by frequency. Gaps are intentionally excluded — they're a
// line-level dispatch/headway phenomenon, not a location phenomenon, so
// plotting them geographically would be misleading.
//
// Locations are resolved lazily:
//   - Bus: near_stop is the pattern stop name; direction is the pid. We
//     load the cached pattern for that pid and find the stop by name.
//     Patterns cached in data/patterns/ with a 7-day TTL (see patterns.js).
//   - Train: near_stop is the station name; route is the line code. We
//     look up trainStations.json filtered by line to disambiguate shared
//     names like "Halsted" across Orange vs Blue.
//
// Only posted=1 rows are counted. Cooldown-suppressed rows (posted=0) are
// duplicates of the same incident within an hour, so including them would
// inflate counts for routes that detect the same bunch on every 5-min tick.

const Path = require('path');
const Fs = require('fs-extra');
const { getDb } = require('./history');
const trainStations = require('../train/data/trainStations.json');

const PATTERNS_DIR = Path.join(__dirname, '..', '..', 'data', 'patterns');
const DAY_MS = 24 * 60 * 60 * 1000;

// Lazy pattern load — cached to disk already by src/bus/patterns.js, so we
// just read whatever's on disk. If a pid's pattern isn't cached, we skip the
// event rather than making a blocking network call during heatmap assembly.
const _patternCache = new Map();
function readCachedPattern(pid) {
  if (_patternCache.has(pid)) return _patternCache.get(pid);
  const path = Path.join(PATTERNS_DIR, `${pid}.json`);
  const pattern = Fs.existsSync(path) ? Fs.readJsonSync(path) : null;
  _patternCache.set(pid, pattern);
  return pattern;
}

function resolveBusStop({ direction, near_stop }) {
  if (!direction || !near_stop) return null;
  const pattern = readCachedPattern(direction);
  if (!pattern) return null;
  const stop = pattern.points.find((p) => p.type === 'S' && p.stopName === near_stop);
  return stop ? { lat: stop.lat, lon: stop.lon } : null;
}

// Fall back across every cached pattern if the event's pid pattern isn't
// resolvable — e.g. the pattern file rolled off the 7-day cache window or
// the event's direction column is blank. Lets stale events still contribute.
function resolveBusStopAnywhere(stopName) {
  if (!stopName) return null;
  for (const file of Fs.readdirSync(PATTERNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const pid = file.replace(/\.json$/, '');
    const pattern = readCachedPattern(pid);
    if (!pattern) continue;
    const stop = pattern.points.find((p) => p.type === 'S' && p.stopName === stopName);
    if (stop) return { lat: stop.lat, lon: stop.lon };
  }
  return null;
}

function resolveTrainStation({ route, near_stop }) {
  if (!near_stop) return null;
  const norm = near_stop.toLowerCase();
  // Prefer stations on the event's line, then fall back to any station.
  const onLine = trainStations.filter((s) => !route || s.lines?.includes(route));
  const pools = [onLine, trainStations];
  for (const pool of pools) {
    for (const s of pool) {
      if (s.name.toLowerCase() === norm) return { lat: s.lat, lon: s.lon, name: s.name };
    }
    // startsWith handles "95th" ↔ "95th/Dan Ryan" variance.
    for (const s of pool) {
      const base = s.name.toLowerCase().split(' (')[0];
      if (base === norm || base.startsWith(norm) || norm.startsWith(base)) {
        return { lat: s.lat, lon: s.lon, name: s.name };
      }
    }
  }
  return null;
}

// Bucket incidents by (label, rounded-lat, rounded-lon). We round coordinates
// to 4 decimals (~11m) so two events at the same intersection land in the
// same bucket even if different patterns give microscopically different stop
// coordinates.
function bucket(events, resolve) {
  const buckets = new Map();
  for (const ev of events) {
    const loc = resolve(ev);
    if (!loc) continue;
    const key = `${loc.name || ev.near_stop}|${loc.lat.toFixed(4)}|${loc.lon.toFixed(4)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.bunching += ev.source === 'bunching' ? 1 : 0;
      existing.gap += ev.source === 'gap' ? 1 : 0;
      if (ev.route) existing.routes.add(ev.route);
    } else {
      buckets.set(key, {
        label: loc.name || ev.near_stop,
        lat: loc.lat,
        lon: loc.lon,
        count: 1,
        bunching: ev.source === 'bunching' ? 1 : 0,
        gap: ev.source === 'gap' ? 1 : 0,
        routes: new Set(ev.route ? [ev.route] : []),
      });
    }
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, routes: [...b.routes] }))
    .sort((a, b) => b.count - a.count);
}

function loadEvents(kind, windowDays, now = Date.now()) {
  const since = now - windowDays * DAY_MS;
  const db = getDb();
  return db.prepare(`
    SELECT route, direction, near_stop FROM bunching_events
    WHERE kind = ? AND posted = 1 AND ts >= ? AND near_stop IS NOT NULL
  `).all(kind, since).map((r) => ({ ...r, source: 'bunching' }));
}

function loadBusHeatmap(windowDays, now = Date.now()) {
  const events = loadEvents('bus', windowDays, now);
  return bucket(events, (ev) => resolveBusStop(ev) || resolveBusStopAnywhere(ev.near_stop));
}

function loadTrainHeatmap(windowDays, now = Date.now()) {
  const events = loadEvents('train', windowDays, now);
  return bucket(events, resolveTrainStation);
}

// Gap leaderboard — groups posted gap events by route for a categorical
// "which routes/lines had the worst headway gaps" summary. Gaps are a
// line-level phenomenon so we aggregate by route rather than by stop; the
// output feeds the threaded reply chart, not the heatmap.
function loadGapLeaderboard(kind, windowDays, now = Date.now()) {
  const since = now - windowDays * DAY_MS;
  const db = getDb();
  const rows = db.prepare(`
    SELECT route, COUNT(*) AS count FROM gap_events
    WHERE kind = ? AND posted = 1 AND ts >= ? AND route IS NOT NULL
    GROUP BY route
    ORDER BY count DESC
  `).all(kind, since);
  return rows.map((r) => ({ route: r.route, count: r.count }));
}

module.exports = {
  loadBusHeatmap,
  loadTrainHeatmap,
  loadGapLeaderboard,
  // exported for tests
  bucket,
  resolveTrainStation,
};
