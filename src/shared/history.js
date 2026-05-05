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
      clear_ticks INTEGER NOT NULL DEFAULT 0,
      affected_from_station TEXT,
      affected_to_station TEXT,
      affected_direction TEXT
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
      active_post_ts INTEGER,
      affected_pid TEXT,
      affected_lo_ft INTEGER,
      affected_hi_ft INTEGER
    );

    CREATE TABLE IF NOT EXISTS thread_quote_posts (
      thread_root_uri TEXT NOT NULL,
      source_post_uri TEXT NOT NULL,
      quote_post_uri TEXT,
      ts INTEGER NOT NULL,
      PRIMARY KEY (thread_root_uri, source_post_uri)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_quote_posts_root ON thread_quote_posts(thread_root_uri);

    CREATE TABLE IF NOT EXISTS ghost_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      route TEXT NOT NULL,
      direction TEXT,
      observed REAL,
      expected REAL,
      missing REAL,
      post_uri TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ghost_events_kind_route_ts
      ON ghost_events(kind, route, ts);

    CREATE TABLE IF NOT EXISTS roundup_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      line TEXT NOT NULL,
      post_uri TEXT NOT NULL UNIQUE,
      post_cid TEXT,
      ts INTEGER NOT NULL,
      expires_ts INTEGER NOT NULL,
      clear_ticks INTEGER NOT NULL DEFAULT 0,
      resolved_ts INTEGER,
      resolution_post_uri TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_roundup_anchors_kind_expires
      ON roundup_anchors(kind, expires_ts);

    CREATE TABLE IF NOT EXISTS meta_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      line TEXT NOT NULL,
      direction TEXT,
      source TEXT NOT NULL,
      severity REAL NOT NULL,
      detail TEXT,
      posted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_meta_signals_kind_line_ts
      ON meta_signals(kind, line, ts);

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
  if (!alertCols.includes('affected_from_station')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN affected_from_station TEXT');
  }
  if (!alertCols.includes('affected_to_station')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN affected_to_station TEXT');
  }
  if (!alertCols.includes('affected_direction')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN affected_direction TEXT');
  }
  const busPulseCols = _db
    .prepare('PRAGMA table_info(bus_pulse_state)')
    .all()
    .map((c) => c.name);
  if (!busPulseCols.includes('affected_pid')) {
    _db.exec('ALTER TABLE bus_pulse_state ADD COLUMN affected_pid TEXT');
  }
  if (!busPulseCols.includes('affected_lo_ft')) {
    _db.exec('ALTER TABLE bus_pulse_state ADD COLUMN affected_lo_ft INTEGER');
  }
  if (!busPulseCols.includes('affected_hi_ft')) {
    _db.exec('ALTER TABLE bus_pulse_state ADD COLUMN affected_hi_ft INTEGER');
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
  const roundupCols = _db
    .prepare('PRAGMA table_info(roundup_anchors)')
    .all()
    .map((c) => c.name);
  if (!roundupCols.includes('clear_ticks')) {
    _db.exec('ALTER TABLE roundup_anchors ADD COLUMN clear_ticks INTEGER NOT NULL DEFAULT 0');
  }
  if (!roundupCols.includes('resolved_ts')) {
    _db.exec('ALTER TABLE roundup_anchors ADD COLUMN resolved_ts INTEGER');
  }
  if (!roundupCols.includes('resolution_post_uri')) {
    _db.exec('ALTER TABLE roundup_anchors ADD COLUMN resolution_post_uri TEXT');
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
  // meta_signals are noisy near-miss records; 48h matches observations rolloff
  // since they're only useful for live correlation, not historical analysis.
  db()
    .prepare('DELETE FROM meta_signals WHERE ts < ?')
    .run(now - 2 * DAY_MS);
}

function getAlertPost(alertId) {
  return db().prepare('SELECT * FROM alert_posts WHERE alert_id = ?').get(alertId) || null;
}

const ALERT_CLEAR_TICKS = 2;
// If an alert was previously resolved and we see it active again after this
// gap, treat the new sighting as a re-published incident and reset tracking.
const ALERT_FLICKER_RESET_MS = 30 * 60 * 1000;

function recordAlertSeen(
  {
    alertId,
    kind,
    routes,
    headline,
    postUri,
    affectedFromStation,
    affectedToStation,
    affectedDirection,
  },
  now = Date.now(),
) {
  const af = affectedFromStation == null ? null : affectedFromStation;
  const at = affectedToStation == null ? null : affectedToStation;
  const ad = affectedDirection == null ? null : affectedDirection;
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
            affected_from_station = COALESCE(?, affected_from_station),
            affected_to_station = COALESCE(?, affected_to_station),
            affected_direction = COALESCE(?, affected_direction),
            resolved_ts = NULL, resolved_reply_uri = NULL, clear_ticks = 0
        WHERE alert_id = ?
      `)
        .run(now, postUri || null, headline || null, routes || null, af, at, ad, alertId);
    } else {
      db()
        .prepare(`
        UPDATE alert_posts
        SET last_seen_ts = ?, post_uri = COALESCE(?, post_uri),
            headline = COALESCE(?, headline), routes = COALESCE(?, routes),
            affected_from_station = COALESCE(?, affected_from_station),
            affected_to_station = COALESCE(?, affected_to_station),
            affected_direction = COALESCE(?, affected_direction)
        WHERE alert_id = ?
      `)
        .run(now, postUri || null, headline || null, routes || null, af, at, ad, alertId);
    }
    return;
  }
  db()
    .prepare(`
    INSERT INTO alert_posts
      (alert_id, kind, routes, headline, first_seen_ts, last_seen_ts, post_uri,
       affected_from_station, affected_to_station, affected_direction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(alertId, kind, routes || null, headline || null, now, now, postUri || null, af, at, ad);
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

// Active observation-pulse posts that are still live anchors for a thread.
// Bus side: held-cluster pulses only (affected_pid is set). Whole-route
// blackouts have no segment, so they're never used as quote anchors.
function listActiveBusPulseAnchors() {
  return db()
    .prepare(`
      SELECT route, started_ts, active_post_uri, affected_pid, affected_lo_ft, affected_hi_ft
      FROM bus_pulse_state
      WHERE active_post_uri IS NOT NULL AND affected_pid IS NOT NULL
    `)
    .all();
}

// Active train pulse anchors carry from/to + direction directly.
function listActiveTrainPulseAnchors() {
  return db()
    .prepare(`
      SELECT line, direction, from_station, to_station, started_ts, active_post_uri
      FROM pulse_state
      WHERE active_post_uri IS NOT NULL
    `)
    .all();
}

function recordGhostEvent({ kind, route, direction, observed, expected, missing, postUri, ts }) {
  db()
    .prepare(`
      INSERT INTO ghost_events (ts, kind, route, direction, observed, expected, missing, post_uri)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      ts || Date.now(),
      kind,
      String(route),
      direction || null,
      observed ?? null,
      expected ?? null,
      missing ?? null,
      postUri,
    );
}

function recordRoundupAnchor({ kind, line, postUri, postCid, ts, ttlMs = 2 * 60 * 60 * 1000 }) {
  db()
    .prepare(`
      INSERT OR REPLACE INTO roundup_anchors (kind, line, post_uri, post_cid, ts, expires_ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(kind, String(line), postUri, postCid || null, ts, ts + ttlMs);
}

function listActiveRoundupAnchors(kind, now = Date.now()) {
  return db()
    .prepare(`
      SELECT line, post_uri, post_cid, ts
      FROM roundup_anchors
      WHERE kind = ? AND expires_ts > ?
    `)
    .all(kind, now);
}

// Roundups that have not yet posted a resolution and are still within the
// freshness window. The resolution sweep iterates these each tick.
function listUnresolvedRoundupAnchors(kind, now = Date.now()) {
  return db()
    .prepare(`
      SELECT id, line, post_uri, post_cid, ts, clear_ticks
      FROM roundup_anchors
      WHERE kind = ? AND resolved_ts IS NULL AND expires_ts > ?
    `)
    .all(kind, now);
}

function updateRoundupClearTicks(id, clearTicks) {
  db().prepare('UPDATE roundup_anchors SET clear_ticks = ? WHERE id = ?').run(clearTicks, id);
}

function markRoundupResolved(id, resolutionPostUri, ts = Date.now()) {
  db()
    .prepare(`
      UPDATE roundup_anchors
      SET resolved_ts = ?, resolution_post_uri = ?
      WHERE id = ?
    `)
    .run(ts, resolutionPostUri, id);
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
// time-windowed approximation. Match on line/direction/from/to in addition
// to ts so a clear posted on an unrelated line+direction can't shadow this
// pulse (real-world false skip on 2026-05-02: an Orange inbound clear at
// 15:40 made the Brown inbound clear at 15:13 appear "already posted").
function hasObservedClearForPulse({ kind, pulseUri }) {
  const pulseEvt = db()
    .prepare(`
    SELECT ts, line, direction, from_station, to_station FROM disruption_events
    WHERE kind = ? AND source = 'observed' AND post_uri = ?
    ORDER BY ts DESC LIMIT 1
  `)
    .get(kind, pulseUri);
  if (!pulseEvt) return false;
  const row = db()
    .prepare(`
    SELECT id FROM disruption_events
    WHERE kind = ? AND source = 'observed-clear' AND posted = 1
      AND ts >= ?
      AND line = ?
      AND IFNULL(direction, '') = IFNULL(?, '')
      AND IFNULL(from_station, '') = IFNULL(?, '')
      AND IFNULL(to_station, '') = IFNULL(?, '')
    LIMIT 1
  `)
    .get(
      kind,
      pulseEvt.ts,
      pulseEvt.line,
      pulseEvt.direction,
      pulseEvt.from_station,
      pulseEvt.to_station,
    );
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
  affectedPid,
  affectedLoFt,
  affectedHiFt,
}) {
  const pid = affectedPid === undefined ? null : affectedPid;
  const lo = affectedLoFt === undefined || affectedLoFt === null ? null : Math.round(affectedLoFt);
  const hi = affectedHiFt === undefined || affectedHiFt === null ? null : Math.round(affectedHiFt);
  db()
    .prepare(`
    INSERT INTO bus_pulse_state
      (route, started_ts, last_seen_ts, consecutive_ticks, clear_ticks,
       posted_cooldown_key, active_post_uri, active_post_ts,
       affected_pid, affected_lo_ft, affected_hi_ft)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(route) DO UPDATE SET
      started_ts = excluded.started_ts,
      last_seen_ts = excluded.last_seen_ts,
      consecutive_ticks = excluded.consecutive_ticks,
      clear_ticks = excluded.clear_ticks,
      posted_cooldown_key = excluded.posted_cooldown_key,
      active_post_uri = excluded.active_post_uri,
      active_post_ts = excluded.active_post_ts,
      affected_pid = excluded.affected_pid,
      affected_lo_ft = excluded.affected_lo_ft,
      affected_hi_ft = excluded.affected_hi_ft
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
      pid,
      lo,
      hi,
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

// Must be called BEFORE recordBunching writes the current event, otherwise
// the callouts compare against the event itself.
//
// Severity semantics: for buses larger vehicle_count wins (tiebreak on span),
// for trains smaller severity_ft (the inter-train distance) wins.
function bunchingCallouts({ kind, route, routeLabel, vehicleCount, severityFt }, now = Date.now()) {
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
  const windowDays = 30;
  const windowStart = now - windowDays * DAY_MS;
  if (kind === 'bus') {
    const row = db()
      .prepare(`
      SELECT MAX(vehicle_count) AS maxVc, MAX(severity_ft) AS maxSpan, COUNT(*) AS c
      FROM bunching_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
    `)
      .get(kind, route, windowStart, startOfDay);
    if (row.c >= 3) {
      const beatsCount = vehicleCount > row.maxVc;
      const tiesCountBeatsSpan = vehicleCount === row.maxVc && severityFt > row.maxSpan;
      if (beatsCount || tiesCountBeatsSpan) {
        out.push(`worst reported on this route in ${windowDays} days`);
      }
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
// Records the highest vehicle_count ever posted for `kind` (across all
// routes / lines). Used by the post-text builder to award a 🥇 medal when a
// new record is set. Excludes the current event itself by virtue of
// recordBunching only writing posted=1 after commitAndPost succeeds —
// callers compare BEFORE recording, so the candidate isn't in the result.
function previousMaxBunchingVehicleCount(kind) {
  const row = db()
    .prepare(
      `SELECT MAX(vehicle_count) AS maxVc
         FROM bunching_events
        WHERE kind = ? AND posted = 1`,
    )
    .get(kind);
  return row?.maxVc ?? 0;
}

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

// Cooldown-bypass for gaps: an active cooldown shouldn't suppress a
// dramatically-more-severe escalation on the same route, nor a disruption
// that simply refuses to clear. Two gates, OR'd:
//
// 1. Decaying escalation margin. Fresh post needs a real spike to break
//    through (1.25×) — ratios bounce ±10–20% as schedules drift, so a 3.1×
//    on top of a 3.0× post on the same incident shouldn't re-fire. The
//    margin decays linearly toward 1.10× across the cooldown window, so a
//    gap that's still bad ~50 min later only needs a modest bump to repost.
// 2. Sustained-severity floor. If ≥ 20 min has elapsed since the prior post
//    and the candidate is still ≥ 3.0× expected, post a follow-up
//    regardless of escalation — the disruption persisting at high ratio is
//    itself news.
const GAP_COOLDOWN_OVERRIDE_MARGIN_FRESH = 1.25;
const GAP_COOLDOWN_OVERRIDE_MARGIN_FLOOR = 1.1;
const GAP_COOLDOWN_OVERRIDE_SUSTAINED_MIN_ELAPSED_MS = 20 * 60 * 1000;
const GAP_COOLDOWN_OVERRIDE_SUSTAINED_RATIO = 3.0;
function gapCooldownAllows(
  { kind, route, candidate, withinMs = 60 * 60 * 1000 },
  now = Date.now(),
) {
  const events = db()
    .prepare(`
    SELECT ratio, ts FROM gap_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `)
    .all(kind, route, now - withinMs);
  if (events.length === 0) return true;
  return events.every((ev) => {
    const elapsed = Math.max(0, now - ev.ts);
    const t = Math.min(1, elapsed / withinMs);
    const margin =
      GAP_COOLDOWN_OVERRIDE_MARGIN_FRESH -
      (GAP_COOLDOWN_OVERRIDE_MARGIN_FRESH - GAP_COOLDOWN_OVERRIDE_MARGIN_FLOOR) * t;
    if (candidate.ratio > ev.ratio * margin) return true;
    if (
      elapsed >= GAP_COOLDOWN_OVERRIDE_SUSTAINED_MIN_ELAPSED_MS &&
      candidate.ratio >= GAP_COOLDOWN_OVERRIDE_SUSTAINED_RATIO
    ) {
      return true;
    }
    return false;
  });
}

function gapCapAllows({ kind, route, candidate, cap, windowStartTs }, now = Date.now()) {
  const start = windowStartTs != null ? windowStartTs : chicagoStartOfDay(now);
  const events = db()
    .prepare(`
    SELECT ratio FROM gap_events
    WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
  `)
    .all(kind, route, start);
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

// Rush-period anchor: AM (05-10), midday (10-15), PM (15-20), evening (20-05).
// Returns the start-of-period ms for the period containing `ts`.
const RUSH_BOUNDARIES_HOURS = [5, 10, 15, 20];
function chicagoStartOfRushPeriod(ts) {
  const dayStart = chicagoStartOfDay(ts);
  const ctParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const ctHour = parseInt(ctParts.find((p) => p.type === 'hour').value, 10) % 24;
  let anchor = -Infinity;
  for (const h of RUSH_BOUNDARIES_HOURS) {
    if (ctHour >= h && h > anchor) anchor = h;
  }
  if (anchor < 0) {
    return dayStart - DAY_MS + 20 * 60 * 60 * 1000;
  }
  return dayStart + anchor * 60 * 60 * 1000;
}

function recordMetaSignal(
  { kind, line, direction, source, severity, detail, posted },
  now = Date.now(),
) {
  db()
    .prepare(`
    INSERT INTO meta_signals (ts, kind, line, direction, source, severity, detail, posted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      now,
      kind,
      line,
      direction || null,
      source,
      severity,
      detail ? JSON.stringify(detail) : null,
      posted ? 1 : 0,
    );
}

function getRecentMetaSignals({ kind, line, withinMs }, now = Date.now()) {
  const sinceTs = now - withinMs;
  const params = [kind, sinceTs];
  let sql = 'SELECT * FROM meta_signals WHERE kind = ? AND ts >= ?';
  if (line) {
    sql += ' AND line = ?';
    params.push(line);
  }
  sql += ' ORDER BY ts DESC';
  return db()
    .prepare(sql)
    .all(...params);
}

function recentPulseOnLine({ kind, line, withinMs }, now = Date.now()) {
  const row = db()
    .prepare(`
    SELECT id, ts FROM disruption_events
    WHERE kind = ? AND line = ? AND posted = 1 AND ts >= ?
    ORDER BY ts DESC LIMIT 1
  `)
    .get(kind, line, now - withinMs);
  return row || null;
}

function recentGhostOnLine({ kind, line, withinMs }, now = Date.now()) {
  const row = db()
    .prepare(`
    SELECT id, ts, severity FROM meta_signals
    WHERE kind = ? AND line = ? AND source = 'ghost' AND ts >= ?
    ORDER BY ts DESC LIMIT 1
  `)
    .get(kind, line, now - withinMs);
  return row || null;
}

function recentDetectorActivity({ kind, line, withinMs }, now = Date.now()) {
  const sinceTs = now - withinMs;
  const gaps = db()
    .prepare(`
      SELECT ts, ratio, posted FROM gap_events
      WHERE kind = ? AND route = ? AND ts >= ?
      ORDER BY ts DESC LIMIT 5
    `)
    .all(kind, line, sinceTs);
  const pulses = db()
    .prepare(`
      SELECT ts, source, posted, from_station, to_station FROM disruption_events
      WHERE kind = ? AND line = ? AND ts >= ?
      ORDER BY ts DESC LIMIT 5
    `)
    .all(kind, line, sinceTs);
  const alerts = db()
    .prepare(`
      SELECT alert_id, first_seen_ts, resolved_ts, headline FROM alert_posts
      WHERE kind = ? AND first_seen_ts >= ?
        AND (',' || COALESCE(routes, '') || ',') LIKE ?
      ORDER BY first_seen_ts DESC LIMIT 5
    `)
    .all(kind, sinceTs, `%,${line},%`);
  return { gaps, pulses, alerts };
}

function recordThreadQuote({ threadRootUri, sourcePostUri, quotePostUri }, now = Date.now()) {
  db()
    .prepare(`
    INSERT OR REPLACE INTO thread_quote_posts
      (thread_root_uri, source_post_uri, quote_post_uri, ts)
    VALUES (?, ?, ?, ?)
  `)
    .run(threadRootUri, sourcePostUri, quotePostUri || null, now);
}

function getThreadQuotedSourceUris(threadRootUri) {
  const rows = db()
    .prepare('SELECT source_post_uri FROM thread_quote_posts WHERE thread_root_uri = ?')
    .all(threadRootUri);
  return new Set(rows.map((r) => r.source_post_uri));
}

function findRelatedAnalyticsPosts({ kind, routes, sinceTs, untilTs, excludeSourceUris }) {
  if (!routes || routes.length === 0) return [];
  const exclude = Array.isArray(excludeSourceUris)
    ? excludeSourceUris
    : excludeSourceUris instanceof Set
      ? [...excludeSourceUris]
      : [];
  const routePlaceholders = routes.map(() => '?').join(',');
  const excludeClause = exclude.length
    ? ` AND post_uri NOT IN (${exclude.map(() => '?').join(',')})`
    : '';
  const baseParams = [kind, ...routes, sinceTs, untilTs, ...exclude];
  const bunchSql = `
    SELECT * FROM bunching_events
    WHERE kind = ? AND route IN (${routePlaceholders})
      AND posted = 1 AND post_uri IS NOT NULL
      AND ts BETWEEN ? AND ?${excludeClause}
  `;
  const gapSql = `
    SELECT * FROM gap_events
    WHERE kind = ? AND route IN (${routePlaceholders})
      AND posted = 1 AND post_uri IS NOT NULL
      AND ts BETWEEN ? AND ?${excludeClause}
  `;
  // Ghost rollup posts can cover multiple routes per post — one ghost_events
  // row per (route, post_uri) is written, so the IN-clause filter works as
  // expected and a single rollup post can match multiple anchor groups.
  const ghostSql = `
    SELECT * FROM ghost_events
    WHERE kind = ? AND route IN (${routePlaceholders})
      AND ts BETWEEN ? AND ?${excludeClause}
  `;
  const bunchRows = db()
    .prepare(bunchSql)
    .all(...baseParams);
  const gapRows = db()
    .prepare(gapSql)
    .all(...baseParams);
  const ghostRows = db()
    .prepare(ghostSql)
    .all(...baseParams);
  const out = [];
  for (const r of bunchRows) {
    out.push({
      source: 'bunching',
      ts: r.ts,
      route: r.route,
      direction: r.direction,
      near_stop: r.near_stop,
      post_uri: r.post_uri,
      raw: r,
    });
  }
  for (const r of gapRows) {
    out.push({
      source: 'gap',
      ts: r.ts,
      route: r.route,
      direction: r.direction,
      near_stop: r.near_stop,
      post_uri: r.post_uri,
      raw: r,
    });
  }
  for (const r of ghostRows) {
    out.push({
      source: 'ghost',
      ts: r.ts,
      route: r.route,
      direction: r.direction,
      near_stop: null, // ghost posts are route-level, no near_stop
      post_uri: r.post_uri,
      raw: r,
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
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
  bunchingCooldownAllows,
  previousMaxBunchingVehicleCount,
  gapCooldownAllows,
  gapCapAllows,
  getAlertPost,
  recordAlertSeen,
  recordAlertResolved,
  incrementAlertClearTicks,
  resetAlertClearTicks,
  listUnresolvedAlerts,
  listActiveBusPulseAnchors,
  listActiveTrainPulseAnchors,
  recordRoundupAnchor,
  listActiveRoundupAnchors,
  listUnresolvedRoundupAnchors,
  updateRoundupClearTicks,
  markRoundupResolved,
  recordGhostEvent,
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
  chicagoStartOfDay,
  chicagoStartOfRushPeriod,
  recordMetaSignal,
  getRecentMetaSignals,
  recentPulseOnLine,
  recentGhostOnLine,
  recentDetectorActivity,
  recordThreadQuote,
  getThreadQuotedSourceUris,
  findRelatedAnalyticsPosts,
};
