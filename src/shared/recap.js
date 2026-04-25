// Heatmap aggregates bunching events to lat/lon hotspots. The gap leaderboard
// stays line-level since gaps are a dispatch/headway phenomenon, not a
// location one. Only posted=1 rows count — cooldown-suppressed duplicates
// would inflate counts on chronically-bad routes.

const Path = require('path');
const Fs = require('fs-extra');
const { getDb } = require('./history');
const trainStations = require('../train/data/trainStations.json');

const PATTERNS_DIR = Path.join(__dirname, '..', '..', 'data', 'patterns');
const DAY_MS = 24 * 60 * 60 * 1000;

// Don't fetch patterns over the network during heatmap assembly — read from
// disk only and skip events whose pid isn't cached.
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

// Last-resort fallback when the event's pid pattern is missing — search every
// cached pattern by stop name. Lets stale events still contribute.
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

// Round to 4 decimals (~11m) so events at the same intersection bucket
// together even when patterns report slightly different stop coordinates.
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

function loadEvents(kind, since, until) {
  const db = getDb();
  return db.prepare(`
    SELECT route, direction, near_stop FROM bunching_events
    WHERE kind = ? AND posted = 1 AND ts >= ? AND ts < ? AND near_stop IS NOT NULL
  `).all(kind, since, until).map((r) => ({ ...r, source: 'bunching' }));
}

function loadBusHeatmap(since, until) {
  const events = loadEvents('bus', since, until);
  return bucket(events, (ev) => resolveBusStop(ev) || resolveBusStopAnywhere(ev.near_stop));
}

function loadTrainHeatmap(since, until) {
  const events = loadEvents('train', since, until);
  return bucket(events, resolveTrainStation);
}

function loadGapLeaderboard(kind, since, until) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT route, COUNT(*) AS count FROM gap_events
    WHERE kind = ? AND posted = 1 AND ts >= ? AND ts < ? AND route IS NOT NULL
    GROUP BY route
    ORDER BY count DESC
  `).all(kind, since, until);
  return rows.map((r) => ({ route: r.route, count: r.count }));
}

// Probe both CT offsets (CST=-6, CDT=-5) and pick the one that round-trips
// to the desired wall time — avoids pulling in a tz library.
function ctWallTimeAsUtcMs(year, month, day, hour) {
  for (const offsetHours of [5, 6]) {
    const candidate = Date.UTC(year, month - 1, day, offsetHours, 0, 0);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    }).formatToParts(new Date(candidate));
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    if (get('year') === year && get('month') === month && get('day') === day && get('hour') === hour) {
      return candidate;
    }
  }
  throw new Error(`No UTC offset lands ${year}-${month}-${day} ${hour}:00 in America/Chicago`);
}

function ctDateParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  return { year: get('year'), month: get('month'), day: get('day') };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// `month` covers the prior calendar month in CT (e.g. on May 1, all of
// April). Matches how readers think about "monthly recap" better than a
// rolling 30-day window.
function rangeForWindow(window, now = Date.now()) {
  if (window === 'week') {
    const until = now;
    const since = until - 7 * DAY_MS;
    const startParts = ctDateParts(since);
    const endParts = ctDateParts(until);
    return { since, until, label: formatRangeLabel(startParts, endParts) };
  }
  if (window === 'month') {
    const today = ctDateParts(now);
    const priorMonth = today.month === 1 ? 12 : today.month - 1;
    const priorYear = today.month === 1 ? today.year - 1 : today.year;
    const since = ctWallTimeAsUtcMs(priorYear, priorMonth, 1, 0);
    const until = ctWallTimeAsUtcMs(today.year, today.month, 1, 0);
    const lastDay = new Date(today.year, today.month - 1, 0).getDate();
    const start = { year: priorYear, month: priorMonth, day: 1 };
    const end = { year: priorYear, month: priorMonth, day: lastDay };
    // Year-disambiguate the label across calendar boundaries (Jan 1 → "Dec 1 – 31, 2025").
    const baseLabel = formatRangeLabel(start, end);
    const label = priorYear !== today.year ? `${baseLabel}, ${priorYear}` : baseLabel;
    return { since, until, label };
  }
  throw new Error(`Unknown window: ${window}`);
}

function formatRangeLabel(start, end) {
  const sameYear = start.year === end.year;
  const sameMonth = sameYear && start.month === end.month;
  const startStr = `${MONTH_NAMES[start.month - 1]} ${start.day}`;
  if (sameMonth) return `${startStr} – ${end.day}`;
  const endStr = `${MONTH_NAMES[end.month - 1]} ${end.day}`;
  return sameYear ? `${startStr} – ${endStr}` : `${startStr}, ${start.year} – ${endStr}, ${end.year}`;
}

module.exports = {
  loadBusHeatmap,
  loadTrainHeatmap,
  loadGapLeaderboard,
  rangeForWindow,
  // exported for tests
  bucket,
  resolveTrainStation,
  formatRangeLabel,
};
