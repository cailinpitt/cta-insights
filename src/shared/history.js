const Path = require('path');
const Fs = require('fs-extra');
const Database = require('better-sqlite3');

const DB_PATH = Path.join(__dirname, '..', '..', 'state', 'history.sqlite');
const ROLLOFF_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

let _db = null;

function db() {
  if (_db) return _db;
  Fs.ensureDirSync(Path.dirname(DB_PATH));
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS bunching_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      route TEXT NOT NULL,
      direction TEXT,
      vehicle_count INTEGER NOT NULL,
      severity_ft INTEGER NOT NULL,
      near_stop TEXT,
      posted INTEGER NOT NULL DEFAULT 0,
      post_uri TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bunching_kind_route_ts
      ON bunching_events(kind, route, ts);

    CREATE TABLE IF NOT EXISTS speedmap_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      route TEXT NOT NULL,
      direction TEXT,
      avg_mph REAL,
      pct_red REAL,
      pct_orange REAL,
      pct_yellow REAL,
      pct_purple REAL,
      pct_green REAL,
      bin_speeds_json TEXT,
      posted INTEGER NOT NULL DEFAULT 0,
      post_uri TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_speedmap_kind_route_ts
      ON speedmap_runs(kind, route, ts);

    CREATE TABLE IF NOT EXISTS gap_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      route TEXT NOT NULL,
      direction TEXT,
      gap_ft INTEGER NOT NULL,
      gap_min REAL NOT NULL,
      expected_min REAL NOT NULL,
      ratio REAL NOT NULL,
      near_stop TEXT,
      posted INTEGER NOT NULL DEFAULT 0,
      post_uri TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gap_kind_route_ts
      ON gap_events(kind, route, ts);

    CREATE TABLE IF NOT EXISTS cooldowns (
      key TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS alert_posts (
      alert_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      routes TEXT,
      headline TEXT,
      first_seen_ts INTEGER NOT NULL,
      last_seen_ts INTEGER NOT NULL,
      post_uri TEXT,
      resolved_ts INTEGER,
      resolved_reply_uri TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_posts_kind
      ON alert_posts(kind);

    CREATE TABLE IF NOT EXISTS disruption_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      line TEXT NOT NULL,
      direction TEXT,
      from_station TEXT,
      to_station TEXT,
      source TEXT NOT NULL,
      posted INTEGER NOT NULL DEFAULT 0,
      post_uri TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_disruption_kind_line_ts
      ON disruption_events(kind, line, ts);

    CREATE TABLE IF NOT EXISTS pulse_state (
      line TEXT NOT NULL,
      direction TEXT NOT NULL,
      run_lo_ft INTEGER,
      run_hi_ft INTEGER,
      from_station TEXT,
      to_station TEXT,
      started_ts INTEGER,
      last_seen_ts INTEGER,
      consecutive_ticks INTEGER NOT NULL DEFAULT 0,
      clear_ticks INTEGER NOT NULL DEFAULT 0,
      posted_cooldown_key TEXT,
      PRIMARY KEY (line, direction)
    );

    CREATE TABLE IF NOT EXISTS observations (
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      route TEXT NOT NULL,
      direction TEXT,
      vehicle_id TEXT NOT NULL,
      destination TEXT,
      lat REAL,
      lon REAL
    );
    CREATE INDEX IF NOT EXISTS idx_obs_kind_route_ts
      ON observations(kind, route, ts);
  `);

  // Migration: add pct_purple to speedmap_runs for trains' 5-bucket schema.
  // Pre-existing rows leave this NULL, which is fine — we only read pct_* as
  // per-row insert values, never aggregated across historical runs.
  const speedmapCols = _db.prepare("PRAGMA table_info(speedmap_runs)").all().map((c) => c.name);
  if (!speedmapCols.includes('pct_purple')) {
    _db.exec('ALTER TABLE speedmap_runs ADD COLUMN pct_purple REAL');
  }

  // Migration: add expires_at to cooldowns for per-key TTLs. Null means
  // "use the caller's default COOLDOWN_MS window."
  const cooldownCols = _db.prepare("PRAGMA table_info(cooldowns)").all().map((c) => c.name);
  if (!cooldownCols.includes('expires_at')) {
    _db.exec('ALTER TABLE cooldowns ADD COLUMN expires_at INTEGER');
  }

  // Migration: add lat/lon to observations so the pulse detector can project
  // historical positions onto line polylines. Existing rows leave them null
  // (still useful for ghost detection which only needs distinct-vid counts).
  const obsCols = _db.prepare("PRAGMA table_info(observations)").all().map((c) => c.name);
  if (!obsCols.includes('lat')) {
    _db.exec('ALTER TABLE observations ADD COLUMN lat REAL');
  }
  if (!obsCols.includes('lon')) {
    _db.exec('ALTER TABLE observations ADD COLUMN lon REAL');
  }

  return _db;
}

function getDb() {
  return db();
}

function rolloffOld(now = Date.now()) {
  const cutoff = now - ROLLOFF_DAYS * DAY_MS;
  db().prepare('DELETE FROM bunching_events WHERE ts < ?').run(cutoff);
  db().prepare('DELETE FROM speedmap_runs WHERE ts < ?').run(cutoff);
  db().prepare('DELETE FROM gap_events WHERE ts < ?').run(cutoff);
  db().prepare('DELETE FROM disruption_events WHERE ts < ?').run(cutoff);
  // Alert posts roll off once the alert has been resolved for 90d.
  db().prepare('DELETE FROM alert_posts WHERE resolved_ts IS NOT NULL AND resolved_ts < ?').run(cutoff);
}

// --- Alert posts (Feature 2: CTA alert ingestion) --------------------------

function getAlertPost(alertId) {
  return db().prepare('SELECT * FROM alert_posts WHERE alert_id = ?').get(alertId) || null;
}

function recordAlertSeen({ alertId, kind, routes, headline, postUri }, now = Date.now()) {
  const existing = getAlertPost(alertId);
  if (existing) {
    db().prepare('UPDATE alert_posts SET last_seen_ts = ?, post_uri = COALESCE(?, post_uri) WHERE alert_id = ?')
      .run(now, postUri || null, alertId);
    return;
  }
  db().prepare(`
    INSERT INTO alert_posts (alert_id, kind, routes, headline, first_seen_ts, last_seen_ts, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(alertId, kind, routes || null, headline || null, now, now, postUri || null);
}

function recordAlertResolved({ alertId, replyUri }, now = Date.now()) {
  db().prepare('UPDATE alert_posts SET resolved_ts = ?, resolved_reply_uri = ? WHERE alert_id = ?')
    .run(now, replyUri || null, alertId);
}

function listUnresolvedAlerts(kind) {
  return db().prepare('SELECT * FROM alert_posts WHERE kind = ? AND resolved_ts IS NULL').all(kind);
}

// --- Disruption events (Feature 1: pulse detector) -------------------------

function recordDisruption({
  kind, line, direction, fromStation, toStation, source, posted, postUri,
}, now = Date.now()) {
  db().prepare(`
    INSERT INTO disruption_events
      (ts, kind, line, direction, from_station, to_station, source, posted, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now, kind, line, direction || null,
    fromStation || null, toStation || null, source, posted ? 1 : 0, postUri || null,
  );
}

// --- Pulse detector state (Feature 1) --------------------------------------

function getPulseState(line, direction) {
  return db().prepare('SELECT * FROM pulse_state WHERE line = ? AND direction = ?')
    .get(line, direction) || null;
}

function upsertPulseState({
  line, direction, runLoFt, runHiFt, fromStation, toStation,
  startedTs, lastSeenTs, consecutiveTicks, clearTicks, postedCooldownKey,
}) {
  db().prepare(`
    INSERT INTO pulse_state
      (line, direction, run_lo_ft, run_hi_ft, from_station, to_station,
       started_ts, last_seen_ts, consecutive_ticks, clear_ticks, posted_cooldown_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(line, direction) DO UPDATE SET
      run_lo_ft = excluded.run_lo_ft,
      run_hi_ft = excluded.run_hi_ft,
      from_station = excluded.from_station,
      to_station = excluded.to_station,
      started_ts = excluded.started_ts,
      last_seen_ts = excluded.last_seen_ts,
      consecutive_ticks = excluded.consecutive_ticks,
      clear_ticks = excluded.clear_ticks,
      posted_cooldown_key = excluded.posted_cooldown_key
  `).run(
    line, direction,
    runLoFt == null ? null : Math.round(runLoFt),
    runHiFt == null ? null : Math.round(runHiFt),
    fromStation || null, toStation || null,
    startedTs || null, lastSeenTs || null,
    consecutiveTicks || 0, clearTicks || 0,
    postedCooldownKey || null,
  );
}

function clearPulseState(line, direction) {
  db().prepare('DELETE FROM pulse_state WHERE line = ? AND direction = ?').run(line, direction);
}

// Midnight Chicago time of the day containing `ts`, returned as a UTC epoch ms.
// Uses the offset at that instant, which is stable enough for "today" windows
// (DST transitions happen at 2am CT, so noon-to-noon queries are never split).
function chicagoStartOfDay(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = get('year'), m = get('month'), day = get('day');
  const h = get('hour'), mi = get('minute'), s = get('second');
  const asUtc = Date.UTC(+y, +m - 1, +day, +h, +mi, +s);
  const offsetMs = d.getTime() - asUtc; // negative for CT (UTC-5/6)
  return Date.UTC(+y, +m - 1, +day) + offsetMs;
}

function recordBunching({
  kind, route, direction, vehicleCount, severityFt, nearStop, posted, postUri,
}, now = Date.now()) {
  db().prepare(`
    INSERT INTO bunching_events
      (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(now, kind, route, direction || null, vehicleCount, Math.round(severityFt), nearStop || null, posted ? 1 : 0, postUri || null);
}

function recordSpeedmap({
  kind, route, direction, avgMph, pctRed, pctOrange, pctYellow, pctPurple, pctGreen, binSpeeds, posted, postUri,
}, now = Date.now()) {
  db().prepare(`
    INSERT INTO speedmap_runs
      (ts, kind, route, direction, avg_mph, pct_red, pct_orange, pct_yellow, pct_purple, pct_green, bin_speeds_json, posted, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now, kind, route, direction || null,
    avgMph == null ? null : avgMph,
    pctRed, pctOrange, pctYellow,
    pctPurple == null ? null : pctPurple,
    pctGreen,
    JSON.stringify(binSpeeds || []),
    posted ? 1 : 0,
    postUri || null,
  );
}

/**
 * Callouts for a bunching detection about to post. Returns an array of short
 * human strings (zero or more) to prepend to the post body.
 *
 * #1 (frequency): "Nth <route> bunch reported today" — counts today's posted
 *   events on the same kind+route (cooldown-suppressed rows don't count, so
 *   the number matches what the bot actually posted).
 * #2 (severity): "tightest bunch on this <line> in N days" (train) or
 *   "largest bunch on this route in N days" (bus), emitted when the current
 *   event is more severe than every prior posted event in the window.
 *
 * Severity semantics differ by kind:
 *   - bus: larger vehicle_count is worse; tiebreak by larger span.
 *   - train: always 2 trains, smaller severity_ft (distance) is tighter/worse.
 *
 * Uses the DB as it stood BEFORE recording this event, so callers must
 * compute callouts before calling recordBunching.
 */
function bunchingCallouts({ kind, route, routeLabel, vehicleCount, severityFt }, now = Date.now()) {
  const out = [];
  const startOfDay = chicagoStartOfDay(now);
  const todayCount = db().prepare(`
    SELECT COUNT(*) AS c FROM bunching_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `).get(kind, route, startOfDay).c;
  // todayCount is PRIOR events today. The event we're about to post is the
  // (todayCount + 1)th.
  const nth = todayCount + 1;
  if (nth >= 2) {
    const label = routeLabel ? `${routeLabel} bunch` : 'bunch';
    out.push(`${ordinal(nth)} ${label} reported today`);
  }

  // Severity — compare against posted events in the last 30 days (excluding
  // today's). Need at least 3 prior to make the callout meaningful.
  const windowDays = 30;
  const windowStart = now - windowDays * DAY_MS;
  if (kind === 'bus') {
    const row = db().prepare(`
      SELECT MAX(vehicle_count) AS maxVc, MAX(severity_ft) AS maxSpan, COUNT(*) AS c
      FROM bunching_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
    `).get(kind, route, windowStart, startOfDay);
    if (row.c >= 3) {
      const beatsCount = vehicleCount > row.maxVc;
      const tiesCountBeatsSpan = vehicleCount === row.maxVc && severityFt > row.maxSpan;
      if (beatsCount || tiesCountBeatsSpan) {
        out.push(`worst reported on this route in ${windowDays} days`);
      }
    }
  } else if (kind === 'train') {
    const row = db().prepare(`
      SELECT MIN(severity_ft) AS minDist, COUNT(*) AS c
      FROM bunching_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
    `).get(kind, route, windowStart, startOfDay);
    if (row.c >= 3 && severityFt < row.minDist) {
      out.push(`tightest reported on this line in ${windowDays} days`);
    }
  }

  return out;
}

/**
 * Callouts for a speedmap run. Severity only — frequency is uninteresting for
 * speedmaps since they run on a schedule.
 *
 * Compares avg_mph against posted runs on the same kind+route in the last 14
 * days. Requires at least 3 prior samples to avoid meaningless "slowest in 0
 * days" on cold start.
 */
function speedmapCallouts({ kind, route, avgMph }, now = Date.now()) {
  if (avgMph == null) return [];
  const out = [];
  const windowDays = 14;
  const windowStart = now - windowDays * DAY_MS;
  const row = db().prepare(`
    SELECT MIN(avg_mph) AS minAvg, MAX(avg_mph) AS maxAvg, COUNT(*) AS c
    FROM speedmap_runs
    WHERE kind = ? AND route = ? AND posted = 1 AND avg_mph IS NOT NULL AND ts >= ?
  `).get(kind, route, windowStart);
  if (row.c < 3) return out;
  if (avgMph < row.minAvg) {
    out.push(`slowest reported in ${windowDays} days`);
  } else if (avgMph > row.maxAvg) {
    out.push(`fastest reported in ${windowDays} days`);
  }
  return out;
}

function recordGap({
  kind, route, direction, gapFt, gapMin, expectedMin, ratio, nearStop, posted, postUri,
}, now = Date.now()) {
  db().prepare(`
    INSERT INTO gap_events
      (ts, kind, route, direction, gap_ft, gap_min, expected_min, ratio, near_stop, posted, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now, kind, route, direction || null,
    Math.round(gapFt),
    Math.round(gapMin * 10) / 10,
    Math.round(expectedMin * 10) / 10,
    Math.round(ratio * 100) / 100,
    nearStop || null,
    posted ? 1 : 0,
    postUri || null,
  );
}

/**
 * Callouts for a gap detection about to post. Mirrors bunchingCallouts:
 * "Nth gap today" for frequency, "worst reported in N days" for severity.
 * Severity here uses the ratio (observed/expected) — that normalizes across
 * high-frequency and low-frequency routes.
 */
function gapCallouts({ kind, route, routeLabel, ratio }, now = Date.now()) {
  const out = [];
  const startOfDay = chicagoStartOfDay(now);
  const todayCount = db().prepare(`
    SELECT COUNT(*) AS c FROM gap_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `).get(kind, route, startOfDay).c;
  const nth = todayCount + 1;
  if (nth >= 2) {
    const label = routeLabel ? `${routeLabel} gap` : 'gap';
    out.push(`${ordinal(nth)} ${label} reported today`);
  }

  const windowDays = 30;
  const windowStart = now - windowDays * DAY_MS;
  const row = db().prepare(`
    SELECT MAX(ratio) AS maxRatio, COUNT(*) AS c
    FROM gap_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
  `).get(kind, route, windowStart, startOfDay);
  if (row.c >= 3 && ratio > row.maxRatio) {
    out.push(`biggest gap vs schedule on this route in ${windowDays} days`);
  }
  return out;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatCallouts(callouts) {
  if (!callouts || callouts.length === 0) return '';
  return `📊 ${callouts.join(' · ')}`;
}

/**
 * Soft daily cap for bunching posts. Returns true if the candidate is allowed
 * to post, either because the route is under the cap or because the candidate
 * is strictly more severe than every bunching posted on the route today. The
 * cap fixes feed-dominance by chronically-bad routes (Route 66 bunches every
 * hour) without suppressing a genuine escalation ("3-bus pileup became a 6").
 *
 * Severity comparison differs by kind:
 *   - bus: larger vehicle_count wins; tiebreak on larger span_ft.
 *   - train: always 2 trains, so smaller span_ft (tighter bunch) wins.
 *
 * `candidate`: { vehicleCount, severityFt }
 */
function bunchingCapAllows({ kind, route, candidate, cap }, now = Date.now()) {
  const events = db().prepare(`
    SELECT vehicle_count AS vc, severity_ft AS sev
    FROM bunching_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `).all(kind, route, chicagoStartOfDay(now));
  if (events.length < cap) return true;
  return events.every((ev) => {
    if (kind === 'bus') {
      if (candidate.vehicleCount > ev.vc) return true;
      if (candidate.vehicleCount === ev.vc && candidate.severityFt > ev.sev) return true;
      return false;
    }
    return candidate.severityFt < ev.sev;
  });
}

/**
 * Soft daily cap for gap posts. Mirrors `bunchingCapAllows` but with a single
 * severity axis: ratio (gap_min / expected_min). A larger ratio means "emptier
 * than schedule implies" — the gap is more severe.
 *
 * `candidate`: { ratio }
 */
function gapCapAllows({ kind, route, candidate, cap }, now = Date.now()) {
  const events = db().prepare(`
    SELECT ratio FROM gap_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `).all(kind, route, chicagoStartOfDay(now));
  if (events.length < cap) return true;
  return events.every((ev) => candidate.ratio > ev.ratio);
}

/**
 * Pick the route from `candidates` whose last posted speedmap is oldest,
 * falling back to never-posted routes first. Keeps speedmap coverage fair
 * across a growing route list — a uniform random pick left popular routes
 * re-covered within a day while long-tail routes went weeks between posts.
 *
 * Only `posted=1` rows count: skipped/empty runs shouldn't make a route
 * look "recently covered." Ties are broken by the order candidates were
 * passed in (stable & predictable; operator can re-order routes.js to
 * influence the rotation).
 */
function leastRecentlyPostedSpeedmapRoute(kind, candidates) {
  if (!candidates || candidates.length === 0) return null;
  const rows = db().prepare(`
    SELECT route, MAX(ts) AS lastTs
    FROM speedmap_runs
    WHERE kind = ? AND posted = 1
    GROUP BY route
  `).all(kind);
  const lastTsByRoute = new Map(rows.map((r) => [r.route, r.lastTs]));
  let best = null;
  let bestTs = Infinity;
  for (const route of candidates) {
    const ts = lastTsByRoute.has(route) ? lastTsByRoute.get(route) : -Infinity;
    if (ts < bestTs) { bestTs = ts; best = route; }
  }
  return best;
}

module.exports = {
  rolloffOld,
  recordBunching,
  recordSpeedmap,
  recordGap,
  bunchingCallouts,
  speedmapCallouts,
  gapCallouts,
  formatCallouts,
  leastRecentlyPostedSpeedmapRoute,
  bunchingCapAllows,
  gapCapAllows,
  getAlertPost,
  recordAlertSeen,
  recordAlertResolved,
  listUnresolvedAlerts,
  recordDisruption,
  getPulseState,
  upsertPulseState,
  clearPulseState,
  getDb,
};
