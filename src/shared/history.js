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
      short_description TEXT,
      first_seen_ts INTEGER NOT NULL,
      last_seen_ts INTEGER NOT NULL,
      post_uri TEXT,
      resolved_ts INTEGER,
      resolved_reply_uri TEXT,
      clear_ticks INTEGER NOT NULL DEFAULT 0,
      affected_from_station TEXT,
      affected_to_station TEXT,
      affected_direction TEXT,
      mentioned_stations TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_posts_kind
      ON alert_posts(kind);

    CREATE TABLE IF NOT EXISTS alert_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      headline TEXT,
      short_description TEXT,
      affected_from_station TEXT,
      affected_to_station TEXT,
      affected_direction TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_versions_alert_ts
      ON alert_versions(alert_id, ts);

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
      post_uri TEXT,
      evidence TEXT
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
      quote_post_cid TEXT,
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
      post_uri TEXT NOT NULL,
      UNIQUE(route, post_uri)
    );
    CREATE INDEX IF NOT EXISTS idx_ghost_events_kind_route_ts
      ON ghost_events(kind, route, ts);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ghost_events_route_post_uri
      ON ghost_events(route, post_uri);

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
      vehicle_ts INTEGER,
      approx INTEGER,
      next_station TEXT,
      trip_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_obs_kind_route_ts
      ON observations(kind, route, ts);

    -- Metra GTFS-realtime TripUpdate snapshots: one row per (snapshot tick,
    -- trip, stop). The substrate for delay computation and inferred-cancellation
    -- detection (a scheduled trip whose stops never get a live prediction).
    -- Unlike CTA, Metra binds each scheduled trip_id to live predictions, so we
    -- store the per-stop predicted vs scheduled times directly rather than
    -- reconstructing service statistically. 7-day rolloff like observations.
    CREATE TABLE IF NOT EXISTS metra_trip_updates (
      ts INTEGER NOT NULL,
      trip_id TEXT NOT NULL,
      route TEXT NOT NULL,
      label TEXT,
      schedule_relationship TEXT,
      stop_id TEXT,
      stop_sequence INTEGER,
      stop_schedule_relationship TEXT,
      predicted_arr INTEGER,
      predicted_dep INTEGER,
      delay_sec INTEGER,
      vehicle_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_metra_tu_trip_ts
      ON metra_trip_updates(trip_id, ts);
    CREATE INDEX IF NOT EXISTS idx_metra_tu_route_ts
      ON metra_trip_updates(route, ts);
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
    // `approx` = 1 marks a position we *synthesized* for a train the feed
    // returned without a usable lat/lon (the 0,0 glitch), recovered from its
    // next-station coords. Stored so the replay/videos can keep the train
    // visible across the dropout, but kept OUT of detection reads by default so
    // ghost/gap/pulse counts are unchanged. `next_station` preserves the
    // recovery source for debugging / future refinement.
    ['approx', 'INTEGER'],
    ['next_station', 'TEXT'],
    // Metra positions carry a GTFS trip_id (e.g. `BNSF_BN1272_V2_B`) that joins
    // directly to the static schedule index. CTA bus/train rows leave it null.
    ['trip_id', 'TEXT'],
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
  // CTA-side timing windows from the alert's EventStart / EventEnd fields.
  // Useful for forensic timing analysis on alerts the CTA scrubs immediately
  // (their `?alertid=` lookup stops returning the row, so we'd otherwise lose
  // CTA's own claimed start/end the moment they pull it from the active feed).
  if (!alertCols.includes('cta_event_start_ts')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN cta_event_start_ts INTEGER');
  }
  if (!alertCols.includes('cta_event_end_ts')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN cta_event_end_ts INTEGER');
  }
  // CTA sometimes posts EventStart/EventEnd as date-only strings (e.g.
  // "2026-05-25") rather than full timestamps. We parse those to end-of-day
  // so any time-math still works, but track the date-only origin so the UI
  // can render "Sun May 25" without a misleading 11:59 PM. Stored as 0/1.
  if (!alertCols.includes('cta_event_start_is_date_only')) {
    _db.exec(
      'ALTER TABLE alert_posts ADD COLUMN cta_event_start_is_date_only INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!alertCols.includes('cta_event_end_is_date_only')) {
    _db.exec(
      'ALTER TABLE alert_posts ADD COLUMN cta_event_end_is_date_only INTEGER NOT NULL DEFAULT 0',
    );
  }
  // CTA's own body text for the alert (ShortDescription, falling back to
  // FullDescription at write time). Surfaced verbatim on the public event
  // page so readers see the reroute/closure details CTA published, not just
  // the one-line headline.
  if (!alertCols.includes('short_description')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN short_description TEXT');
  }
  // Backdate support: when the first missing tick fires, stash its timestamp
  // here. recordAlertResolved promotes it to resolved_ts when the clear-tick
  // threshold trips, so the recorded resolution time reflects the first tick
  // CTA dropped the alert, not the threshold tick (~one cadence later).
  if (!alertCols.includes('pending_resolved_ts')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN pending_resolved_ts INTEGER');
  }
  // Canonical station names mentioned in the alert text, resolved against the
  // line's roster (line-scoped to disambiguate cross-line same-named stations).
  // JSON-encoded array of strings. Drives station-page coverage and stats for
  // CTA alerts the same way `from_station`/`to_station` does for bot
  // observations. See extractMentionedStations in shared/ctaAlerts.
  if (!alertCols.includes('mentioned_stations')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN mentioned_stations TEXT');
  }
  // Single-train Metra cancellation lifecycle (kind='metra'). When an alert
  // annuls exactly one scheduled train, classifyCancellationAlert resolves it to
  // that trip's timetable so the event is anchored to the SCHEDULE, not to Metra's
  // GTFS-rt feed (which leaves cancellations on the wire for hours and drifts out
  // of sync with metra.com). `cancel_state` is the rider-facing label the export
  // ships verbatim — 'upcoming' (announced, before the scheduled departure) →
  // 'cancelled' (departure has passed; terminal). `cancel_dep_ts`/`cancel_arr_ts`
  // are the scheduled origin departure / final arrival; `cancel_train_no` and
  // `cancel_origin` are the train number and origin station for display. On
  // finalize we also stamp `resolved_ts` (the generic "event ended" marker) so the
  // row leaves listUnresolvedAlerts and never reaches the feed-drop "resolved"
  // sweep — a cancelled train doesn't un-cancel. `cancel_state` IS NULL for every
  // non-cancellation alert (open-ended notices keep the ongoing→resolved model).
  if (!alertCols.includes('cancel_state')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN cancel_state TEXT');
  }
  if (!alertCols.includes('cancel_dep_ts')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN cancel_dep_ts INTEGER');
  }
  if (!alertCols.includes('cancel_arr_ts')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN cancel_arr_ts INTEGER');
  }
  if (!alertCols.includes('cancel_train_no')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN cancel_train_no TEXT');
  }
  if (!alertCols.includes('cancel_origin')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN cancel_origin TEXT');
  }
  // Schedule-anchored single-train DELAY tracking (the delay analog of the
  // cancel_* columns). A qualified delay ("25 to 35 minutes behind schedule")
  // resolves to one scheduled trip, and `delay_deadline_ts` is when that train —
  // given its final scheduled arrival plus the announced delay plus a grace buffer
  // — should have completed its run. Past that, the lifecycle finalizes the event
  // off the timetable instead of waiting for Metra to drop the alert from the feed.
  // `delay_min` is the announced magnitude and `delay_train_no` the run number,
  // both for display. All NULL for every non-delay alert.
  if (!alertCols.includes('delay_deadline_ts')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN delay_deadline_ts INTEGER');
  }
  if (!alertCols.includes('delay_min')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN delay_min INTEGER');
  }
  if (!alertCols.includes('delay_train_no')) {
    _db.exec('ALTER TABLE alert_posts ADD COLUMN delay_train_no TEXT');
  }
  // Seed alert_versions with the current state of every alert_posts row that
  // has no version history yet. Runs once at startup after the table is
  // created (or after an existing DB picks up the new table on this deploy).
  // Without this, the event page's "Message history" timeline would be empty
  // for every pre-existing alert until CTA happens to edit it again.
  _db.exec(`
    INSERT INTO alert_versions
      (alert_id, ts, headline, short_description,
       affected_from_station, affected_to_station, affected_direction)
    SELECT
      ap.alert_id, ap.first_seen_ts, ap.headline, ap.short_description,
      ap.affected_from_station, ap.affected_to_station, ap.affected_direction
    FROM alert_posts ap
    WHERE NOT EXISTS (
      SELECT 1 FROM alert_versions av WHERE av.alert_id = ap.alert_id
    )
  `);
  const disruptionCols = _db
    .prepare('PRAGMA table_info(disruption_events)')
    .all()
    .map((c) => c.name);
  if (!disruptionCols.includes('evidence')) {
    _db.exec('ALTER TABLE disruption_events ADD COLUMN evidence TEXT');
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
  // Backdate support: timestamp of the first clean tick of the current
  // clear-tick run. postClearReply uses this for the observed-clear row's
  // ts so the recorded clear lines up with real recovery, not the threshold
  // tick a couple cadences later.
  if (!pulseCols.includes('clear_started_ts')) {
    _db.exec('ALTER TABLE pulse_state ADD COLUMN clear_started_ts INTEGER');
  }
  if (!busPulseCols.includes('clear_started_ts')) {
    _db.exec('ALTER TABLE bus_pulse_state ADD COLUMN clear_started_ts INTEGER');
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
  if (!roundupCols.includes('signals')) {
    _db.exec('ALTER TABLE roundup_anchors ADD COLUMN signals TEXT');
  }
  // Backdate support: timestamp of the first below-threshold tick of the
  // current clear-tick run. markRoundupResolved promotes it to resolved_ts
  // when the threshold trips.
  if (!roundupCols.includes('pending_resolved_ts')) {
    _db.exec('ALTER TABLE roundup_anchors ADD COLUMN pending_resolved_ts INTEGER');
  }
  // Structured per-source bullets the post composed from, as JSON:
  // [{source, detail}]. meta_signals roll off at 48h, so this lets the web
  // export render the same bullets on the event page indefinitely.
  if (!roundupCols.includes('bullets')) {
    _db.exec('ALTER TABLE roundup_anchors ADD COLUMN bullets TEXT');
  }
  const threadQuoteCols = _db
    .prepare('PRAGMA table_info(thread_quote_posts)')
    .all()
    .map((c) => c.name);
  if (!threadQuoteCols.includes('quote_post_cid')) {
    _db.exec('ALTER TABLE thread_quote_posts ADD COLUMN quote_post_cid TEXT');
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
  // Event tables (bunching, gaps, speedmaps, disruptions, alerts) are kept
  // forever for historical archiving on the public web dashboard.
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
  // Metra trip-update snapshots are live-detection substrate (delay + inferred
  // cancellation), not a historical archive — 7-day rolloff like observations.
  db()
    .prepare('DELETE FROM metra_trip_updates WHERE ts < ?')
    .run(now - 7 * DAY_MS);
}

function getAlertPost(alertId) {
  return db().prepare('SELECT * FROM alert_posts WHERE alert_id = ?').get(alertId) || null;
}

// Bumped to 3 alongside the 2-min alerts cadence — 6 min absent before we
// post a resolution, still flicker-safe but tighter than the prior 20-min
// floor. resolved_ts itself is backdated to the first missing tick.
const ALERT_CLEAR_TICKS = 3;
// If an alert was previously resolved and we see it active again after this
// gap, treat the new sighting as a re-published incident and reset tracking.
const ALERT_FLICKER_RESET_MS = 30 * 60 * 1000;

function recordAlertSeen(
  {
    alertId,
    kind,
    routes,
    headline,
    shortDescription,
    postUri,
    affectedFromStation,
    affectedToStation,
    affectedDirection,
    mentionedStations,
    ctaEventStartTs,
    ctaEventEndTs,
    ctaEventStartIsDateOnly,
    ctaEventEndIsDateOnly,
  },
  now = Date.now(),
) {
  const af = affectedFromStation == null ? null : affectedFromStation;
  const at = affectedToStation == null ? null : affectedToStation;
  const ad = affectedDirection == null ? null : affectedDirection;
  // Empty array → null so downstream consumers and exports treat "no mentions"
  // and "never extracted" the same. JSON-encoded so SQLite stays string-typed.
  const ms =
    Array.isArray(mentionedStations) && mentionedStations.length > 0
      ? JSON.stringify(mentionedStations)
      : null;
  const es = ctaEventStartTs == null ? null : ctaEventStartTs;
  const ee = ctaEventEndTs == null ? null : ctaEventEndTs;
  const esDate = ctaEventStartIsDateOnly ? 1 : 0;
  const eeDate = ctaEventEndIsDateOnly ? 1 : 0;
  const sd = shortDescription == null ? null : shortDescription;
  const existing = getAlertPost(alertId);
  // Decide whether to record a new version row. A "version" is the
  // user-visible message text plus its affected scope; CTA edits any of
  // these as the situation evolves (e.g. "trains stopped" → "service
  // restoring"). We only count a change when the incoming value is
  // non-null and differs from what's stored — the surrounding UPDATEs use
  // COALESCE(?, col), so a null incoming value preserves the existing
  // column and shouldn't count as a change.
  function changed(incoming, stored) {
    return incoming != null && incoming !== stored;
  }
  const isVersionChange =
    !existing ||
    changed(headline, existing.headline) ||
    changed(sd, existing.short_description) ||
    changed(af, existing.affected_from_station) ||
    changed(at, existing.affected_to_station) ||
    changed(ad, existing.affected_direction);
  function insertVersion() {
    db()
      .prepare(`
        INSERT INTO alert_versions
          (alert_id, ts, headline, short_description,
           affected_from_station, affected_to_station, affected_direction)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        alertId,
        now,
        headline ?? existing?.headline ?? null,
        sd ?? existing?.short_description ?? null,
        af ?? existing?.affected_from_station ?? null,
        at ?? existing?.affected_to_station ?? null,
        ad ?? existing?.affected_direction ?? null,
      );
  }
  if (existing) {
    const wasResolved = existing.resolved_ts != null;
    // A genuinely new chapter under the same alert id: the post finally landed
    // after a premature resolution sweep wiped resolved_ts before any post
    // existed, or CTA re-published the same id after a long enough gap to count
    // as a fresh incident. New chapters start clean — clear resolved_ts AND the
    // prior chapter's resolution reply, and log a version unconditionally so
    // the timeline shows the gap even if the text is unchanged.
    const newChapter =
      wasResolved &&
      ((postUri && !existing.post_uri) || now - existing.last_seen_ts > ALERT_FLICKER_RESET_MS);
    // A short flicker: CTA dropped the alert long enough for us to resolve it
    // (≥ ALERT_CLEAR_TICKS absent) but re-listed it within the flicker window.
    // It's the SAME incident, not a new one — clear resolved_ts so tracking
    // resumes and the duration reflects the real end, but KEEP
    // resolved_reply_uri so postResolution skips a duplicate "CTA cleared"
    // reply when it re-resolves. Without this, an alert that flickers out for
    // 6–30 min stays frozen at the premature resolved_ts while versions and
    // last_seen_ts keep advancing (duration < time of the last version).
    const flickerReopen = wasResolved && !newChapter;
    // SQL fragment that clears the resolution columns for this sighting. No
    // bound params — the values are constant — so it embeds directly.
    const resolutionReset = newChapter
      ? ', resolved_ts = NULL, resolved_reply_uri = NULL, clear_ticks = 0'
      : flickerReopen
        ? ', resolved_ts = NULL, clear_ticks = 0'
        : '';
    if (newChapter || isVersionChange) insertVersion();
    db()
      .prepare(`
        UPDATE alert_posts
        SET last_seen_ts = ?, post_uri = COALESCE(?, post_uri),
            headline = COALESCE(?, headline), routes = COALESCE(?, routes),
            short_description = COALESCE(?, short_description),
            affected_from_station = COALESCE(?, affected_from_station),
            affected_to_station = COALESCE(?, affected_to_station),
            affected_direction = COALESCE(?, affected_direction),
            mentioned_stations = COALESCE(?, mentioned_stations),
            cta_event_start_ts = COALESCE(?, cta_event_start_ts),
            cta_event_start_is_date_only = CASE WHEN ? IS NULL THEN cta_event_start_is_date_only ELSE ? END,
            cta_event_end_ts = COALESCE(?, cta_event_end_ts),
            cta_event_end_is_date_only = CASE WHEN ? IS NULL THEN cta_event_end_is_date_only ELSE ? END${resolutionReset}
        WHERE alert_id = ?
      `)
      .run(
        now,
        postUri || null,
        headline || null,
        routes || null,
        sd,
        af,
        at,
        ad,
        ms,
        es,
        es,
        esDate,
        ee,
        ee,
        eeDate,
        alertId,
      );
    return;
  }
  insertVersion();
  db()
    .prepare(`
    INSERT INTO alert_posts
      (alert_id, kind, routes, headline, short_description,
       first_seen_ts, last_seen_ts, post_uri,
       affected_from_station, affected_to_station, affected_direction,
       mentioned_stations,
       cta_event_start_ts, cta_event_start_is_date_only,
       cta_event_end_ts, cta_event_end_is_date_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      alertId,
      kind,
      routes || null,
      headline || null,
      sd,
      now,
      now,
      postUri || null,
      af,
      at,
      ad,
      ms,
      es,
      esDate,
      ee,
      eeDate,
    );
}

function recordAlertResolved({ alertId, replyUri }, now = Date.now()) {
  // Prefer pending_resolved_ts (first missing tick) over now (threshold tick)
  // so the recorded resolution time is independent of cron cadence.
  db()
    .prepare(`
      UPDATE alert_posts
      SET resolved_ts = COALESCE(pending_resolved_ts, ?),
          resolved_reply_uri = ?,
          pending_resolved_ts = NULL
      WHERE alert_id = ?
    `)
    .run(now, replyUri || null, alertId);
}

// Record (or refresh) the schedule-anchored facts of a single-train cancellation
// and initialize its state to 'upcoming'. Idempotent: the window fields are
// COALESCE'd (set once, from the schedule), and the state is only initialized when
// unset — it never downgrades a row finalizeCancellation has already moved to
// 'cancelled'. The bin calls this every tick for a not-yet-finalized cancellation.
function recordCancellation({ alertId, depTs, arrTs, trainNo, origin }) {
  db()
    .prepare(`
      UPDATE alert_posts
      SET cancel_dep_ts = COALESCE(cancel_dep_ts, ?),
          cancel_arr_ts = COALESCE(cancel_arr_ts, ?),
          cancel_train_no = COALESCE(cancel_train_no, ?),
          cancel_origin = COALESCE(cancel_origin, ?),
          cancel_state = CASE WHEN cancel_state IS NULL THEN 'upcoming' ELSE cancel_state END
      WHERE alert_id = ?
    `)
    .run(depTs ?? null, arrTs ?? null, trainNo ?? null, origin ?? null, alertId);
}

// Finalize a single-train cancellation once its scheduled departure has passed:
// flip the label to 'cancelled' and stamp resolved_ts so it leaves the unresolved
// set (and the feed-drop "resolved" sweep). resolved_ts is the honest "this train's
// slot passed" moment — the scheduled departure, but never before we first saw the
// alert (an annulment announced after departure is dated to when we learned of it,
// keeping resolved_ts >= first_seen_ts). The neutral close-note reply uri is stored
// in resolved_reply_uri (null when the post failed), mirroring recordAlertResolved.
function finalizeCancellation({ alertId, replyUri }) {
  db()
    .prepare(`
      UPDATE alert_posts
      SET cancel_state = 'cancelled',
          resolved_ts = COALESCE(resolved_ts, MAX(cancel_dep_ts, first_seen_ts)),
          resolved_reply_uri = COALESCE(resolved_reply_uri, ?)
      WHERE alert_id = ?
    `)
    .run(replyUri || null, alertId);
}

// Record (or refresh) the schedule-anchored deadline of a single-train delay. The
// magnitude and run number are set once (COALESCE), but the deadline is pushed to
// the LATEST seen value (MAX) — if Metra updates the alert with a worse delay, the
// resolve time moves out with it, so we never close while the train is still more
// delayed than first announced. Never touches a row already finalized (resolved_ts
// set); the bin calls this every tick for a not-yet-resolved delay.
function recordDelay({ alertId, deadlineTs, delayMin, trainNo }) {
  db()
    .prepare(`
      UPDATE alert_posts
      SET delay_deadline_ts = CASE
            WHEN delay_deadline_ts IS NULL THEN ?
            ELSE MAX(delay_deadline_ts, ?)
          END,
          delay_min = COALESCE(delay_min, ?),
          delay_train_no = COALESCE(delay_train_no, ?)
      WHERE alert_id = ? AND resolved_ts IS NULL
    `)
    .run(deadlineTs ?? null, deadlineTs ?? null, delayMin ?? null, trainNo ?? null, alertId);
}

// Finalize a single-train delay once its deadline has passed: stamp resolved_ts so
// the row leaves listUnresolvedAlerts (and the feed-drop "resolved" sweep). The
// honest "event ended" moment is the deadline — when the train should have arrived —
// but never before we first saw the alert. The neutral close-note reply uri goes in
// resolved_reply_uri (null when the post failed), mirroring finalizeCancellation.
function finalizeDelay({ alertId, replyUri }) {
  db()
    .prepare(`
      UPDATE alert_posts
      SET resolved_ts = COALESCE(resolved_ts, MAX(delay_deadline_ts, first_seen_ts)),
          resolved_reply_uri = COALESCE(resolved_reply_uri, ?)
      WHERE alert_id = ?
    `)
    .run(replyUri || null, alertId);
}

function incrementAlertClearTicks(alertId, now = Date.now()) {
  // Stamp pending_resolved_ts on the 0→1 transition only. COALESCE keeps an
  // earlier value if somehow set twice; recordAlertResolved/reset clear it.
  db()
    .prepare(`
      UPDATE alert_posts
      SET clear_ticks = clear_ticks + 1,
          pending_resolved_ts = COALESCE(pending_resolved_ts, ?)
      WHERE alert_id = ?
    `)
    .run(now, alertId);
  const row = db().prepare('SELECT clear_ticks FROM alert_posts WHERE alert_id = ?').get(alertId);
  return row ? row.clear_ticks : 0;
}

function resetAlertClearTicks(alertId) {
  db()
    .prepare(
      'UPDATE alert_posts SET clear_ticks = 0, pending_resolved_ts = NULL WHERE alert_id = ?',
    )
    .run(alertId);
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
      INSERT OR IGNORE INTO ghost_events (ts, kind, route, direction, observed, expected, missing, post_uri)
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

function recordRoundupAnchor({
  kind,
  line,
  postUri,
  postCid,
  ts,
  signals,
  bullets,
  ttlMs = 2 * 60 * 60 * 1000,
}) {
  // signals: array of source strings, e.g. ['gap', 'bunching']
  // bullets: structured picks the post composed from — [{source, detail}]
  const signalsStr = signals && signals.length > 0 ? [...new Set(signals)].join(',') : null;
  const bulletsStr = bullets && bullets.length > 0 ? JSON.stringify(bullets) : null;
  db()
    .prepare(`
      INSERT OR REPLACE INTO roundup_anchors (kind, line, post_uri, post_cid, ts, expires_ts, signals, bullets)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(kind, String(line), postUri, postCid || null, ts, ts + ttlMs, signalsStr, bulletsStr);
}

function listActiveRoundupAnchors(kind, now = Date.now()) {
  // resolved_ts IS NULL: once a roundup has posted its resolution, it's no
  // longer a valid anchor for related-quote attachments. Without this filter,
  // observations could land on the thread after "back to normal" was posted.
  return db()
    .prepare(`
      SELECT line, post_uri, post_cid, ts
      FROM roundup_anchors
      WHERE kind = ? AND expires_ts > ? AND resolved_ts IS NULL
    `)
    .all(kind, now);
}

// Roundups that have not yet posted a resolution. The resolution sweep
// iterates these each tick.
//
// No expires_ts filter: expires_ts gates whether new observations can attach
// reply quotes to the thread (a freshness question), but resolution is a
// separate concern — an incident that's still firing past the 2h TTL must
// still be allowed to auto-resolve once signals quiet, otherwise the anchor
// is orphaned forever.
function listUnresolvedRoundupAnchors(kind) {
  return db()
    .prepare(`
      SELECT id, line, post_uri, post_cid, ts, clear_ticks
      FROM roundup_anchors
      WHERE kind = ? AND resolved_ts IS NULL
    `)
    .all(kind);
}

function updateRoundupClearTicks(id, clearTicks, now = Date.now(), pendingClearTs = now) {
  // Reset → null the pending stamp. Advance to ≥1 → set pending if unset
  // (first tick of the clean run). markRoundupResolved promotes it.
  //
  // pendingClearTs lets the caller pass a refined moment for when the
  // underlying signals actually went quiet (e.g. the last contributing
  // meta_signal's ts) rather than the 5-min cron tick that noticed. The
  // COALESCE means later ticks can't overwrite the first stamp.
  if (clearTicks === 0) {
    db()
      .prepare(
        'UPDATE roundup_anchors SET clear_ticks = 0, pending_resolved_ts = NULL WHERE id = ?',
      )
      .run(id);
    return;
  }
  db()
    .prepare(`
      UPDATE roundup_anchors
      SET clear_ticks = ?,
          pending_resolved_ts = COALESCE(pending_resolved_ts, ?)
      WHERE id = ?
    `)
    .run(clearTicks, pendingClearTs, id);
}

function markRoundupResolved(id, resolutionPostUri, ts = Date.now()) {
  db()
    .prepare(`
      UPDATE roundup_anchors
      SET resolved_ts = COALESCE(pending_resolved_ts, ?),
          resolution_post_uri = ?,
          pending_resolved_ts = NULL
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
    WHERE kind = ? AND source = 'observed-clear'
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
  // Exclude pulses that already have a paired 'observed-clear' on the same
  // line/direction/segment after them. Without this filter, a CTA alert can
  // get threaded under a pulse whose Bluesky thread already has a resolution
  // reply at the bottom — resolveReplyRef walks to the latest leaf and lands
  // the alert as a reply to "service has been restored", which reads as
  // contradictory. Mirrors the pairing logic export-web.js uses.
  return db()
    .prepare(`
    SELECT d.id, d.ts, d.from_station, d.to_station, d.direction, d.post_uri
    FROM disruption_events d
    WHERE d.kind = ? AND d.line = ? AND d.source = 'observed'
      AND d.posted = 1 AND d.post_uri IS NOT NULL
      AND d.ts >= ?
      AND NOT EXISTS (
        SELECT 1 FROM disruption_events c
        WHERE c.kind = d.kind AND c.source = 'observed-clear'
          AND c.ts >= d.ts
          AND IFNULL(c.line, '')          = IFNULL(d.line, '')
          AND IFNULL(c.direction, '')     = IFNULL(d.direction, '')
          AND IFNULL(c.from_station, '')  = IFNULL(d.from_station, '')
          AND IFNULL(c.to_station, '')    = IFNULL(d.to_station, '')
      )
    ORDER BY d.ts DESC LIMIT 10
  `)
    .all(kind, line, now - withinMs);
}

function recordDisruption(
  { kind, line, direction, fromStation, toStation, source, posted, postUri, evidence = null },
  now = Date.now(),
) {
  // Serialize the evidence object as JSON. Empty objects become null so the
  // 'observed-clear' rows (which carry no payload) keep their column NULL
  // and the export-side reader doesn't have to skip empty objects.
  let evidenceJson = null;
  if (evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0) {
    try {
      evidenceJson = JSON.stringify(evidence);
    } catch (_e) {
      evidenceJson = null;
    }
  }
  db()
    .prepare(`
    INSERT INTO disruption_events
      (ts, kind, line, direction, from_station, to_station, source, posted, post_uri, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      evidenceJson,
    );
}

// Metra trip_ids already recorded for a service date in the given disruption
// `sources`, so the hourly detector doesn't re-insert one it logged on an earlier
// run. Keyed on the trip_id + serviceDate in the evidence JSON (the same trip_id
// repeats every weekday, so dedup MUST be scoped to the service date). Defaults to
// the cancellation sources; pass `['delay']` for the delay pass. Returns a Set.
function getMetraRecordedTripIds(serviceDate, sources = ['cancellation', 'cancellation-inferred']) {
  const placeholders = sources.map(() => '?').join(',');
  const rows = db()
    .prepare(`
    SELECT DISTINCT json_extract(evidence, '$.tripId') AS tripId
    FROM disruption_events
    WHERE kind = 'metra'
      AND source IN (${placeholders})
      AND json_extract(evidence, '$.serviceDate') = ?
  `)
    .all(...sources, serviceDate);
  return new Set(rows.map((r) => r.tripId).filter(Boolean));
}

// All Metra disruption_events in [since, until) — the recap substrate. Returns
// rows with the evidence JSON parsed (delayMin/headsign/scheduledDepLabel/…). The
// 90-day rolloff on disruption_events means this works for both the weekly and
// the monthly recap window (unlike metra_trip_updates, which rolls off at 7 days).
function getMetraDisruptions(since, until) {
  const rows = db()
    .prepare(`
    SELECT ts, line, source, evidence FROM disruption_events
    WHERE kind = 'metra' AND ts >= ? AND ts < ?
  `)
    .all(since, until);
  return rows.map((r) => {
    let evidence = null;
    try {
      evidence = r.evidence ? JSON.parse(r.evidence) : null;
    } catch (_e) {
      evidence = null;
    }
    return { ts: r.ts, line: r.line, source: r.source, evidence };
  });
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
  clearStartedTs = null,
}) {
  db()
    .prepare(`
    INSERT INTO pulse_state
      (line, direction, run_lo_ft, run_hi_ft, from_station, to_station,
       started_ts, last_seen_ts, consecutive_ticks, clear_ticks, posted_cooldown_key,
       active_post_uri, active_post_ts, clear_started_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      active_post_ts = excluded.active_post_ts,
      clear_started_ts = excluded.clear_started_ts
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
      clearStartedTs || null,
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
  clearStartedTs = null,
}) {
  const pid = affectedPid === undefined ? null : affectedPid;
  const lo = affectedLoFt === undefined || affectedLoFt === null ? null : Math.round(affectedLoFt);
  const hi = affectedHiFt === undefined || affectedHiFt === null ? null : Math.round(affectedHiFt);
  db()
    .prepare(`
    INSERT INTO bus_pulse_state
      (route, started_ts, last_seen_ts, consecutive_ticks, clear_ticks,
       posted_cooldown_key, active_post_uri, active_post_ts,
       affected_pid, affected_lo_ft, affected_hi_ft, clear_started_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      affected_hi_ft = excluded.affected_hi_ft,
      clear_started_ts = excluded.clear_started_ts
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
      clearStartedTs || null,
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

function recordThreadQuote(
  { threadRootUri, sourcePostUri, quotePostUri, quotePostCid },
  now = Date.now(),
) {
  db()
    .prepare(`
    INSERT OR REPLACE INTO thread_quote_posts
      (thread_root_uri, source_post_uri, quote_post_uri, quote_post_cid, ts)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(threadRootUri, sourcePostUri, quotePostUri || null, quotePostCid || null, now);
}

function getThreadQuotedSourceUris(threadRootUri) {
  const rows = db()
    .prepare('SELECT source_post_uri FROM thread_quote_posts WHERE thread_root_uri = ?')
    .all(threadRootUri);
  return new Set(rows.map((r) => r.source_post_uri));
}

// Latest quote post we've authored under this thread root. The next quote
// replies to this so the thread stays linear (one reply per post) instead of
// branching off the anchor.
function getLatestThreadQuote(threadRootUri) {
  const row = db()
    .prepare(`
      SELECT quote_post_uri, quote_post_cid FROM thread_quote_posts
      WHERE thread_root_uri = ? AND quote_post_uri IS NOT NULL
      ORDER BY ts DESC LIMIT 1
    `)
    .get(threadRootUri);
  if (!row?.quote_post_cid) return null;
  return { uri: row.quote_post_uri, cid: row.quote_post_cid };
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
  recordCancellation,
  finalizeCancellation,
  recordDelay,
  finalizeDelay,
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
  getMetraRecordedTripIds,
  getMetraDisruptions,
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
  getLatestThreadQuote,
  findRelatedAnalyticsPosts,
};
