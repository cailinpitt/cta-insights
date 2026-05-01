const Path = require('node:path');
const Fs = require('fs-extra');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', '..', 'state', 'history.sqlite');
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
      resolved_reply_uri TEXT,
      clear_ticks INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS bus_pulse_state (
      route TEXT PRIMARY KEY,
      started_ts INTEGER,
      last_seen_ts INTEGER,
      consecutive_ticks INTEGER NOT NULL DEFAULT 0,
      clear_ticks INTEGER NOT NULL DEFAULT 0,
      posted_cooldown_key TEXT,
      active_post_uri TEXT,
      active_post_ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS observations (
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      route TEXT NOT NULL,
      direction TEXT,
      vehicle_id TEXT NOT NULL,
      destination TEXT,
      lat REAL,
      lon REAL,
      pdist REAL,
      heading INTEGER,
      vehicle_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_obs_kind_route_ts
      ON observations(kind, route, ts);
  `);

  // Column migrations for DBs that predate the current schema.
  const speedmapCols = _db
    .prepare('PRAGMA table_info(speedmap_runs)')
    .all()
    .map((c) => c.name);
  if (!speedmapCols.includes('pct_purple')) {
    _db.exec('ALTER TABLE speedmap_runs ADD COLUMN pct_purple REAL');
  }
  const cooldownCols = _db
    .prepare('PRAGMA table_info(cooldowns)')
    .all()
    .map((c) => c.name);
  if (!cooldownCols.includes('expires_at')) {
    _db.exec('ALTER TABLE cooldowns ADD COLUMN expires_at INTEGER');
  }
  const obsCols = _db
    .prepare('PRAGMA table_info(observations)')
    .all()
    .map((c) => c.name);
  for (const [name, type] of [
    ['lat', 'REAL'],
    ['lon', 'REAL'],
    ['pdist', 'REAL'],
    ['heading', 'INTEGER'],
    ['vehicle_ts', 'INTEGER'],
  ]) {
    if (!obsCols.includes(name)) _db.exec(`ALTER TABLE observations ADD COLUMN ${name} ${type}`);
  }
  const alertCols = _db
    .prepare('PRAGMA table_info(alert_posts)')
    .all()
    .map((c) => c.name);
  if (!alertCols.includes('clear_ticks')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN clear_ticks INTEGER NOT NULL DEFAULT 0');
  }
  const pulseCols = _db
    .prepare('PRAGMA table_info(pulse_state)')
    .all()
    .map((c) => c.name);
  if (!pulseCols.includes('active_post_uri')) {
    _db.exec('ALTER TABLE pulse_state ADD COLUMN active_post_uri TEXT');
  }
  if (!pulseCols.includes('active_post_ts')) {
    _db.exec('ALTER TABLE pulse_state ADD COLUMN active_post_ts INTEGER');
  }
  // One-time cleanup of stale `branch-N` direction keys from before the
  // stable-direction-key change. Gated on user_version so this runs exactly
  // once per DB; without the gate the DELETE fired on every cron startup and
  // wiped in-flight pulse_state rows, defeating the debounce.
  const userVersion = _db.pragma('user_version', { simple: true });
  if (userVersion < 1) {
    _db.exec(
      "DELETE FROM pulse_state WHERE direction GLOB 'branch-[0-9]' OR direction GLOB 'branch-[0-9][0-9]'",
    );
    _db.pragma('user_version = 1');
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
  // Alerts only roll off after they've been resolved for 90d — preserves the
  // post URI so resolution replies can still thread to the original.
  db()
    .prepare('DELETE FROM alert_posts WHERE resolved_ts IS NOT NULL AND resolved_ts < ?')
    .run(cutoff);
  // Cooldowns: drop expired rows + ancient legacy null-ttl rows.
  db()
    .prepare(
      'DELETE FROM cooldowns WHERE (expires_at IS NOT NULL AND expires_at < ?) OR (expires_at IS NULL AND ts < ?)',
    )
    .run(now, cutoff);
}

function getAlertPost(alertId) {
  return db().prepare('SELECT * FROM alert_posts WHERE alert_id = ?').get(alertId) || null;
}

const ALERT_CLEAR_TICKS = 2;
const BUNCHING_RECORD_WINDOW_DAYS = 30;
const MIN_RECORD_PRIOR_EVENTS = 3;
// If an alert was previously resolved and we see it active again after this
// gap, treat the new sighting as a re-published incident and reset tracking.
const ALERT_FLICKER_RESET_MS = 30 * 60 * 1000;

function recordAlertSeen({ alertId, kind, routes, headline, postUri }, now = Date.now()) {
  const existing = getAlertPost(alertId);
  if (existing) {
    // Re-engage tracking when (a) post finally lands after a premature
    // resolution sweep wiped resolved_ts before any post existed, or (b) the
    // alert was previously resolved and CTA re-published the same id after a
    // gap. Both end up with resolved_ts non-null and need clearing here, or
    // listUnresolvedAlerts will never pick the row up again.
    const reEngage =
      existing.resolved_ts != null &&
      ((postUri && !existing.post_uri) || now - existing.last_seen_ts > ALERT_FLICKER_RESET_MS);
    if (reEngage) {
      db()
        .prepare(`
        UPDATE alert_posts
        SET last_seen_ts = ?, post_uri = COALESCE(?, post_uri),
            headline = COALESCE(?, headline), routes = COALESCE(?, routes),
            resolved_ts = NULL, resolved_reply_uri = NULL, clear_ticks = 0
        WHERE alert_id = ?
      `)
        .run(now, postUri || null, headline || null, routes || null, alertId);
    } else {
      db()
        .prepare(`
        UPDATE alert_posts
        SET last_seen_ts = ?, post_uri = COALESCE(?, post_uri),
            headline = COALESCE(?, headline), routes = COALESCE(?, routes)
        WHERE alert_id = ?
      `)
        .run(now, postUri || null, headline || null, routes || null, alertId);
    }
    return;
  }
  db()
    .prepare(`
    INSERT INTO alert_posts (alert_id, kind, routes, headline, first_seen_ts, last_seen_ts, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .run(alertId, kind, routes || null, headline || null, now, now, postUri || null);
}

function recordAlertResolved({ alertId, replyUri }, now = Date.now()) {
  db()
    .prepare('UPDATE alert_posts SET resolved_ts = ?, resolved_reply_uri = ? WHERE alert_id = ?')
    .run(now, replyUri || null, alertId);
}

function incrementAlertClearTicks(alertId) {
  db()
    .prepare('UPDATE alert_posts SET clear_ticks = clear_ticks + 1 WHERE alert_id = ?')
    .run(alertId);
  const row = db().prepare('SELECT clear_ticks FROM alert_posts WHERE alert_id = ?').get(alertId);
  return row ? row.clear_ticks : 0;
}

function resetAlertClearTicks(alertId) {
  db().prepare('UPDATE alert_posts SET clear_ticks = 0 WHERE alert_id = ?').run(alertId);
}

function listUnresolvedAlerts(kind) {
  return db().prepare('SELECT * FROM alert_posts WHERE kind = ? AND resolved_ts IS NULL').all(kind);
}

function getRecentPulsePost(
  { kind, line, direction, withinMs = 3 * 60 * 60 * 1000 },
  now = Date.now(),
) {
  const params = [kind, line, now - withinMs];
  let sql = `
    SELECT id, ts, from_station, to_station, direction, post_uri FROM disruption_events
    WHERE kind = ? AND line = ? AND source = 'observed'
      AND posted = 1 AND post_uri IS NOT NULL
      AND ts >= ?
  `;
  if (direction) {
    sql += ' AND direction = ?';
    params.push(direction);
  }
  sql += ' ORDER BY ts DESC LIMIT 1';
  return (
    db()
      .prepare(sql)
      .get(...params) || null
  );
}

// Asks "is there an unresolved CTA alert on this route right now?". Replaces
// the old time-windowed `ctaAlertPostedSince` which missed CTA-first-pulse-
// second cases (alert's first_seen_ts < pulse start).
function hasUnresolvedCtaAlert({ kind, ctaRouteCode }) {
  const row = db()
    .prepare(`
    SELECT alert_id FROM alert_posts
    WHERE kind = ? AND post_uri IS NOT NULL AND resolved_ts IS NULL
      AND (',' || routes || ',') LIKE ?
    LIMIT 1
  `)
    .get(kind, `%,${ctaRouteCode},%`);
  return !!row;
}

// Exact-pulse idempotency: did we already post an observed-clear after the
// posted observed event with this URI? Replaces `hasObservedClearSince`'s
// time-windowed approximation.
function hasObservedClearForPulse({ kind, pulseUri }) {
  const pulseEvt = db()
    .prepare(`
    SELECT ts FROM disruption_events
    WHERE kind = ? AND source = 'observed' AND post_uri = ?
    ORDER BY ts DESC LIMIT 1
  `)
    .get(kind, pulseUri);
  if (!pulseEvt) return false;
  const row = db()
    .prepare(`
    SELECT id FROM disruption_events
    WHERE kind = ? AND source = 'observed-clear' AND posted = 1 AND ts >= ?
    LIMIT 1
  `)
    .get(kind, pulseEvt.ts);
  return !!row;
}

// Phase 4 helper — returns up to 10 most recent pulse posts on a line for
// caller-side scoring (e.g. station-overlap matching).
function getRecentPulsePostsAll({ kind, line, withinMs }, now = Date.now()) {
  return db()
    .prepare(`
    SELECT id, ts, from_station, to_station, direction, post_uri
    FROM disruption_events
    WHERE kind = ? AND line = ? AND source = 'observed'
      AND posted = 1 AND post_uri IS NOT NULL
      AND ts >= ?
    ORDER BY ts DESC LIMIT 10
  `)
    .all(kind, line, now - withinMs);
}

function recordDisruption(
  { kind, line, direction, fromStation, toStation, source, posted, postUri },
  now = Date.now(),
) {
  db()
    .prepare(`
    INSERT INTO disruption_events
      (ts, kind, line, direction, from_station, to_station, source, posted, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      now,
      kind,
      line,
      direction || null,
      fromStation || null,
      toStation || null,
      source,
      posted ? 1 : 0,
      postUri || null,
    );
}

function getPulseState(line, direction) {
  return (
    db()
      .prepare('SELECT * FROM pulse_state WHERE line = ? AND direction = ?')
      .get(line, direction) || null
  );
}

function upsertPulseState({
  line,
  direction,
  runLoFt,
  runHiFt,
  fromStation,
  toStation,
  startedTs,
  lastSeenTs,
  consecutiveTicks,
  clearTicks,
  postedCooldownKey,
  activePostUri = null,
  activePostTs = null,
}) {
  db()
    .prepare(`
    INSERT INTO pulse_state
      (line, direction, run_lo_ft, run_hi_ft, from_station, to_station,
       started_ts, last_seen_ts, consecutive_ticks, clear_ticks, posted_cooldown_key,
       active_post_uri, active_post_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(line, direction) DO UPDATE SET
      run_lo_ft = excluded.run_lo_ft,
      run_hi_ft = excluded.run_hi_ft,
      from_station = excluded.from_station,
      to_station = excluded.to_station,
      started_ts = excluded.started_ts,
      last_seen_ts = excluded.last_seen_ts,
      consecutive_ticks = excluded.consecutive_ticks,
      clear_ticks = excluded.clear_ticks,
      posted_cooldown_key = excluded.posted_cooldown_key,
      active_post_uri = excluded.active_post_uri,
      active_post_ts = excluded.active_post_ts
  `)
    .run(
      line,
      direction,
      runLoFt == null ? null : Math.round(runLoFt),
      runHiFt == null ? null : Math.round(runHiFt),
      fromStation || null,
      toStation || null,
      startedTs || null,
      lastSeenTs || null,
      consecutiveTicks || 0,
      clearTicks || 0,
      postedCooldownKey || null,
      activePostUri || null,
      activePostTs || null,
    );
}

function clearPulseState(line, direction) {
  db().prepare('DELETE FROM pulse_state WHERE line = ? AND direction = ?').run(line, direction);
}

function getBusPulseState(route) {
  return db().prepare('SELECT * FROM bus_pulse_state WHERE route = ?').get(String(route)) || null;
}

function upsertBusPulseState({
  route,
  startedTs,
  lastSeenTs,
  consecutiveTicks,
  clearTicks,
  postedCooldownKey,
  activePostUri = null,
  activePostTs = null,
}) {
  db()
    .prepare(`
    INSERT INTO bus_pulse_state
      (route, started_ts, last_seen_ts, consecutive_ticks, clear_ticks,
       posted_cooldown_key, active_post_uri, active_post_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(route) DO UPDATE SET
      started_ts = excluded.started_ts,
      last_seen_ts = excluded.last_seen_ts,
      consecutive_ticks = excluded.consecutive_ticks,
      clear_ticks = excluded.clear_ticks,
      posted_cooldown_key = excluded.posted_cooldown_key,
      active_post_uri = excluded.active_post_uri,
      active_post_ts = excluded.active_post_ts
  `)
    .run(
      String(route),
      startedTs || null,
      lastSeenTs || null,
      consecutiveTicks || 0,
      clearTicks || 0,
      postedCooldownKey || null,
      activePostUri || null,
      activePostTs || null,
    );
}

function clearBusPulseState(route) {
  db().prepare('DELETE FROM bus_pulse_state WHERE route = ?').run(String(route));
}

// DST transitions happen at 2am CT, so any noon-anchored window is safe;
// "today" queries against this aren't split by the Mar/Nov clock change.
function chicagoStartOfDay(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = get('year'),
    m = get('month'),
    day = get('day');
  const h = get('hour'),
    mi = get('minute'),
    s = get('second');
  const asUtc = Date.UTC(+y, +m - 1, +day, +h, +mi, +s);
  const offsetMs = d.getTime() - asUtc; // negative for CT (UTC-5/6)
  return Date.UTC(+y, +m - 1, +day) + offsetMs;
}

function recordBunching(
  { kind, route, direction, vehicleCount, severityFt, nearStop, posted, postUri },
  now = Date.now(),
) {
  db()
    .prepare(`
    INSERT INTO bunching_events
      (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      now,
      kind,
      route,
      direction || null,
      vehicleCount,
      Math.round(severityFt),
      nearStop || null,
      posted ? 1 : 0,
      postUri || null,
    );
}

function recordSpeedmap(
  {
    kind,
    route,
    direction,
    avgMph,
    pctRed,
    pctOrange,
    pctYellow,
    pctPurple,
    pctGreen,
    binSpeeds,
    posted,
    postUri,
  },
  now = Date.now(),
) {
  db()
    .prepare(`
    INSERT INTO speedmap_runs
      (ts, kind, route, direction, avg_mph, pct_red, pct_orange, pct_yellow, pct_purple, pct_green, bin_speeds_json, posted, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      now,
      kind,
      route,
      direction || null,
      avgMph == null ? null : avgMph,
      pctRed,
      pctOrange,
      pctYellow,
      pctPurple == null ? null : pctPurple,
      pctGreen,
      JSON.stringify(binSpeeds || []),
      posted ? 1 : 0,
      postUri || null,
    );
}

function compareBusBunchingSeverity(a, b) {
  if (a.vehicleCount !== b.vehicleCount) return a.vehicleCount - b.vehicleCount;
  return a.severityFt - b.severityFt;
}

function strongestPriorBusBunching(whereClause, params) {
  return (
    db()
      .prepare(`
      SELECT route,
             direction,
             vehicle_count AS vehicleCount,
             severity_ft AS severityFt,
             ts
      FROM bunching_events
      WHERE kind = 'bus' AND posted = 1 ${whereClause}
      ORDER BY vehicle_count DESC, severity_ft DESC, ts DESC
      LIMIT 1
    `)
      .get(...params) || null
  );
}

function countPriorBusBunching(whereClause, params) {
  return db()
    .prepare(`
      SELECT COUNT(*) AS c
      FROM bunching_events
      WHERE kind = 'bus' AND posted = 1 ${whereClause}
    `)
    .get(...params).c;
}

function getBusBunchingRecordContext({ route, vehicleCount, severityFt }, now = Date.now()) {
  const windowDays = BUNCHING_RECORD_WINDOW_DAYS;
  const windowStart = now - windowDays * DAY_MS;
  const candidate = { vehicleCount, severityFt: Math.round(severityFt) };

  const routeWhere = 'AND route = ? AND ts >= ? AND ts < ?';
  const networkWhere = 'AND ts >= ? AND ts < ?';
  const routeParams = [route, windowStart, now];
  const networkParams = [windowStart, now];

  const routePriorCount = countPriorBusBunching(routeWhere, routeParams);
  const networkPriorCount = countPriorBusBunching(networkWhere, networkParams);
  const strongestRoutePrior = strongestPriorBusBunching(routeWhere, routeParams);
  const strongestNetworkPrior = strongestPriorBusBunching(networkWhere, networkParams);

  const routeRecord =
    routePriorCount >= MIN_RECORD_PRIOR_EVENTS &&
    (!strongestRoutePrior || compareBusBunchingSeverity(candidate, strongestRoutePrior) > 0);
  const networkRecord =
    networkPriorCount >= MIN_RECORD_PRIOR_EVENTS &&
    (!strongestNetworkPrior || compareBusBunchingSeverity(candidate, strongestNetworkPrior) > 0);

  return {
    windowDays,
    routeRecord,
    networkRecord,
    routePriorCount,
    networkPriorCount,
    strongestRoutePrior,
    strongestNetworkPrior,
  };
}

// Must be called BEFORE recordBunching writes the current event, otherwise
// the callouts compare against the event itself.
//
// Severity semantics: for buses larger vehicle_count wins (tiebreak on span),
// for trains smaller severity_ft (the inter-train distance) wins.
function bunchingCallouts(
  { kind, route, routeLabel, vehicleCount, severityFt, recordContext = null },
  now = Date.now(),
) {
  const out = [];
  const startOfDay = chicagoStartOfDay(now);
  const todayCount = db()
    .prepare(`
    SELECT COUNT(*) AS c FROM bunching_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `)
    .get(kind, route, startOfDay).c;
  const nth = todayCount + 1;
  if (nth >= 2) {
    const label = routeLabel ? `${routeLabel} bunch` : 'bunch';
    out.push(`${ordinal(nth)} ${label} reported today`);
  }

  // 3-prior-event minimum keeps cold-start runs from emitting "worst in 0 days."
  const windowDays = BUNCHING_RECORD_WINDOW_DAYS;
  const windowStart = now - windowDays * DAY_MS;
  if (kind === 'bus') {
    const ctx =
      recordContext || getBusBunchingRecordContext({ route, vehicleCount, severityFt }, now);
    if (ctx.routeRecord && !ctx.networkRecord) {
      out.push(`worst reported on this route in ${windowDays} days`);
    }
  } else if (kind === 'train') {
    const row = db()
      .prepare(`
      SELECT MIN(severity_ft) AS minDist, COUNT(*) AS c
      FROM bunching_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
    `)
      .get(kind, route, windowStart, startOfDay);
    if (row.c >= 3 && severityFt < row.minDist) {
      out.push(`tightest reported on this line in ${windowDays} days`);
    }
  }

  return out;
}

function speedmapCallouts({ kind, route, avgMph }, now = Date.now()) {
  if (avgMph == null) return [];
  const out = [];
  const windowDays = 14;
  const windowStart = now - windowDays * DAY_MS;
  const row = db()
    .prepare(`
    SELECT MIN(avg_mph) AS minAvg, MAX(avg_mph) AS maxAvg, COUNT(*) AS c
    FROM speedmap_runs
    WHERE kind = ? AND route = ? AND posted = 1 AND avg_mph IS NOT NULL AND ts >= ?
  `)
    .get(kind, route, windowStart);
  if (row.c < 3) return out;
  if (avgMph < row.minAvg) {
    out.push(`slowest reported in ${windowDays} days`);
  } else if (avgMph > row.maxAvg) {
    out.push(`fastest reported in ${windowDays} days`);
  }
  return out;
}

function recordGap(
  { kind, route, direction, gapFt, gapMin, expectedMin, ratio, nearStop, posted, postUri },
  now = Date.now(),
) {
  db()
    .prepare(`
    INSERT INTO gap_events
      (ts, kind, route, direction, gap_ft, gap_min, expected_min, ratio, near_stop, posted, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      now,
      kind,
      route,
      direction || null,
      Math.round(gapFt),
      Math.round(gapMin * 10) / 10,
      Math.round(expectedMin * 10) / 10,
      Math.round(ratio * 100) / 100,
      nearStop || null,
      posted ? 1 : 0,
      postUri || null,
    );
}

// Severity uses ratio (observed/expected) to normalize across high- and
// low-frequency routes.
function gapCallouts({ kind, route, routeLabel, ratio }, now = Date.now()) {
  const out = [];
  const startOfDay = chicagoStartOfDay(now);
  const todayCount = db()
    .prepare(`
    SELECT COUNT(*) AS c FROM gap_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `)
    .get(kind, route, startOfDay).c;
  const nth = todayCount + 1;
  if (nth >= 2) {
    const label = routeLabel ? `${routeLabel} gap` : 'gap';
    out.push(`${ordinal(nth)} ${label} reported today`);
  }

  const windowDays = 30;
  const windowStart = now - windowDays * DAY_MS;
  const row = db()
    .prepare(`
    SELECT MAX(ratio) AS maxRatio, COUNT(*) AS c
    FROM gap_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
  `)
    .get(kind, route, windowStart, startOfDay);
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

// Soft cap: a chronically-bad route gets `cap` posts/day, but a strictly-more-
// severe escalation ("3-bus pileup → 6") still gets through.
function bunchingCapAllows({ kind, route, candidate, cap }, now = Date.now()) {
  const events = db()
    .prepare(`
    SELECT vehicle_count AS vc, severity_ft AS sev
    FROM bunching_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `)
    .all(kind, route, chicagoStartOfDay(now));
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

// Cooldown-bypass for bunching: an active route-level cooldown shouldn't
// suppress a strictly-more-severe escalation on the same route. Returns true
// when the candidate dominates every posted bunch on this route within
// `withinMs` (default 1h to match COOLDOWN_MS).
function bunchingCooldownAllows(
  { kind, route, candidate, withinMs = 60 * 60 * 1000 },
  now = Date.now(),
) {
  const events = db()
    .prepare(`
    SELECT vehicle_count AS vc, severity_ft AS sev
    FROM bunching_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `)
    .all(kind, route, now - withinMs);
  if (events.length === 0) return true;
  return events.every((ev) => {
    if (kind === 'bus') {
      if (candidate.vehicleCount > ev.vc) return true;
      if (candidate.vehicleCount === ev.vc && candidate.severityFt > ev.sev) return true;
      return false;
    }
    return candidate.severityFt < ev.sev;
  });
}

function gapCapAllows({ kind, route, candidate, cap }, now = Date.now()) {
  const events = db()
    .prepare(`
    SELECT ratio FROM gap_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `)
    .all(kind, route, chicagoStartOfDay(now));
  if (events.length < cap) return true;
  return events.every((ev) => candidate.ratio > ev.ratio);
}

// Only posted=1 rows count: a skipped/empty run shouldn't make a route look
// "recently covered." Ties break in candidate order, so routes.js ordering
// influences the rotation.
function leastRecentlyPostedSpeedmapRoute(kind, candidates) {
  if (!candidates || candidates.length === 0) return null;
  const rows = db()
    .prepare(`
    SELECT route, MAX(ts) AS lastTs
    FROM speedmap_runs
    WHERE kind = ? AND posted = 1
    GROUP BY route
  `)
    .all(kind);
  const lastTsByRoute = new Map(rows.map((r) => [r.route, r.lastTs]));
  let best = null;
  let bestTs = Infinity;
  for (const route of candidates) {
    const ts = lastTsByRoute.has(route) ? lastTsByRoute.get(route) : -Infinity;
    if (ts < bestTs) {
      bestTs = ts;
      best = route;
    }
  }
  return best;
}

module.exports = {
  rolloffOld,
  recordBunching,
  recordSpeedmap,
  recordGap,
  bunchingCallouts,
  getBusBunchingRecordContext,
  speedmapCallouts,
  gapCallouts,
  formatCallouts,
  leastRecentlyPostedSpeedmapRoute,
  bunchingCapAllows,
  bunchingCooldownAllows,
  gapCapAllows,
  getAlertPost,
  recordAlertSeen,
  recordAlertResolved,
  incrementAlertClearTicks,
  resetAlertClearTicks,
  listUnresolvedAlerts,
  ALERT_CLEAR_TICKS,
  recordDisruption,
  getRecentPulsePost,
  getRecentPulsePostsAll,
  hasObservedClearForPulse,
  hasUnresolvedCtaAlert,
  getPulseState,
  upsertPulseState,
  clearPulseState,
  getBusPulseState,
  upsertBusPulseState,
  clearBusPulseState,
  getDb,
  ALERT_FLICKER_RESET_MS,
};
