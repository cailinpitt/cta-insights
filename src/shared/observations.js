const { getDb } = require('./history');

// Detection only looks back ~1h. 7-day retention covers reply-with-evidence
// over the visible Bluesky timeline window and lets bus-pulse / bus-alerts
// PID discovery (KNOWN_PIDS_LOOKBACK_MS) cover low-frequency overnight and
// weekend-only route variants without special-casing.
const ROLLOFF_MS = 7 * 24 * 60 * 60 * 1000;

function rolloffOldObservations(now = Date.now()) {
  getDb()
    .prepare('DELETE FROM observations WHERE ts < ?')
    .run(now - ROLLOFF_MS);
}

// Errors are swallowed so a logger hiccup never breaks the API caller.
function recordBusObservations(vehicles, now = Date.now()) {
  if (!vehicles || vehicles.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO observations
        (ts, kind, route, direction, vehicle_id, destination, lat, lon, pdist, heading, vehicle_ts)
      VALUES (?, 'bus', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const v of items) {
        if (!v.vid || !v.route) continue;
        const tmstmpMs = v.tmstmp instanceof Date ? v.tmstmp.getTime() : null;
        stmt.run(
          now,
          String(v.route),
          v.pid != null ? String(v.pid) : null,
          String(v.vid),
          v.destination || null,
          Number.isFinite(v.lat) ? v.lat : null,
          Number.isFinite(v.lon) ? v.lon : null,
          Number.isFinite(v.pdist) ? v.pdist : null,
          Number.isFinite(v.heading) ? v.heading : null,
          tmstmpMs,
        );
      }
    });
    tx(vehicles);
  } catch (e) {
    console.warn(`recordBusObservations failed: ${e.message}`);
  }
}

function recordTrainObservations(trains, now = Date.now()) {
  if (!trains || trains.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO observations
        (ts, kind, route, direction, vehicle_id, destination, lat, lon, approx, next_station)
      VALUES (?, 'train', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const t of items) {
        if (!t.rn || !t.line) continue;
        stmt.run(
          now,
          String(t.line),
          t.trDr != null ? String(t.trDr) : null,
          String(t.rn),
          t.destination || null,
          Number.isFinite(t.lat) ? t.lat : null,
          Number.isFinite(t.lon) ? t.lon : null,
          t.approx ? 1 : 0,
          t.nextStation || t.recoveredFrom || null,
        );
      }
    });
    tx(trains);
  } catch (e) {
    console.warn(`recordTrainObservations failed: ${e.message}`);
  }
}

// Metra GTFS-rt VehiclePositions. Stored in the shared observations table with
// kind='metra' so the corridor/speed reads work the same as bus/train, plus the
// GTFS `trip_id` (which joins directly to the static schedule index — unlike CTA,
// where vehicles are anonymous). `direction`/`destination` are left null at
// ingest; detectors resolve them from the index via trip_id. Errors swallowed so
// a logger hiccup never breaks the API caller.
function recordMetraObservations(positions, now = Date.now()) {
  if (!positions || positions.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO observations
        (ts, kind, route, direction, vehicle_id, destination, lat, lon, heading, vehicle_ts, trip_id)
      VALUES (?, 'metra', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const p of items) {
        // A position with no route is unusable; skip. vehicle_id falls back
        // through label → vehicleId → tripId so a row always has an id.
        if (!p.routeId) continue;
        const vid = p.label || p.vehicleId || p.tripId;
        if (!vid) continue;
        stmt.run(
          now,
          String(p.routeId),
          null,
          String(vid),
          null,
          Number.isFinite(p.lat) ? p.lat : null,
          Number.isFinite(p.lon) ? p.lon : null,
          Number.isFinite(p.bearing) ? Math.round(p.bearing) : null,
          Number.isFinite(p.ts) ? p.ts : null,
          p.tripId != null ? String(p.tripId) : null,
        );
      }
    });
    tx(positions);
  } catch (e) {
    console.warn(`recordMetraObservations failed: ${e.message}`);
  }
}

// Metra GTFS-rt TripUpdates flattened to one row per (snapshot tick, trip, stop).
// This is the delay + inferred-cancellation substrate: a scheduled trip whose
// stops carry concrete predictions is running; one whose stops stay NO_DATA past
// its departure is a candidate ghost. Errors swallowed (see above).
function recordMetraTripUpdates(tripUpdates, now = Date.now()) {
  if (!tripUpdates || tripUpdates.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO metra_trip_updates
        (ts, trip_id, route, label, schedule_relationship, stop_id, stop_sequence,
         stop_schedule_relationship, predicted_arr, predicted_dep, delay_sec, vehicle_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const tu of items) {
        if (!tu.tripId || !tu.routeId) continue;
        // A trip with no stop_time_updates still gets one summary row (stop
        // fields null) so a CANCELED trip with an empty stop list is recorded.
        const stops = tu.stopUpdates && tu.stopUpdates.length > 0 ? tu.stopUpdates : [null];
        for (const s of stops) {
          stmt.run(
            now,
            String(tu.tripId),
            String(tu.routeId),
            tu.label != null ? String(tu.label) : null,
            tu.scheduleRelationship != null ? String(tu.scheduleRelationship) : null,
            s?.stopId != null ? String(s.stopId) : null,
            Number.isFinite(s?.stopSequence) ? s.stopSequence : null,
            s?.scheduleRelationship != null ? String(s.scheduleRelationship) : null,
            Number.isFinite(s?.arrivalTime) ? s.arrivalTime : null,
            Number.isFinite(s?.departureTime) ? s.departureTime : null,
            Number.isFinite(s?.delay) ? s.delay : null,
            Number.isFinite(tu.timestamp) ? tu.timestamp : null,
          );
        }
      }
    });
    tx(tripUpdates);
  } catch (e) {
    console.warn(`recordMetraTripUpdates failed: ${e.message}`);
  }
}

// --- Metra cancellation-detection reads (Phase 2). Built from the data
// observeMetra continuously records, so the hourly detector reflects everything
// the feed showed in the window, not just a single tick. ---

// Distinct (trip_id, route) flagged CANCELED in the trip-updates feed since
// `sinceTs` — the CONFIRMED cancellations Metra reported in the window.
function getMetraCanceledTrips(sinceTs) {
  return getDb()
    .prepare(`
    SELECT DISTINCT trip_id AS tripId, route
    FROM metra_trip_updates
    WHERE schedule_relationship = 'CANCELED' AND ts >= ? AND trip_id IS NOT NULL
  `)
    .all(sinceTs);
}

// Set of trip_ids that had at least one real vehicle position since `sinceTs` —
// "this train actually ran" (used to clear inferred-cancellation candidates).
function getMetraObservedTripIds(sinceTs) {
  const rows = getDb()
    .prepare(`
    SELECT DISTINCT trip_id FROM observations
    WHERE kind = 'metra' AND trip_id IS NOT NULL AND ts >= ?
  `)
    .all(sinceTs);
  return new Set(rows.map((r) => r.trip_id));
}

// Set of trip_ids producing real (non-NO_DATA) live predictions since `sinceTs` —
// a trip with a concrete predicted arrival/departure is running, so it's not a
// ghost even if no position row landed under its trip_id.
function getMetraLivePredictionTripIds(sinceTs) {
  const rows = getDb()
    .prepare(`
    SELECT DISTINCT trip_id FROM metra_trip_updates
    WHERE trip_id IS NOT NULL AND ts >= ?
      AND (predicted_arr IS NOT NULL OR predicted_dep IS NOT NULL)
  `)
    .all(sinceTs);
  return new Set(rows.map((r) => r.trip_id));
}

// Distinct Metra snapshot timestamps since `sinceTs` (from positions), for the
// feed-health guard — gaps here mean the feed/ingestion stalled.
function getMetraSnapshotTimestamps(sinceTs) {
  const rows = getDb()
    .prepare(`
    SELECT DISTINCT ts FROM observations
    WHERE kind = 'metra' AND ts >= ?
  `)
    .all(sinceTs);
  return rows.map((r) => r.ts);
}

// Recent Metra positions for corridor/speed reads, mirroring
// getRecentTrainPositions. `direction`/`destination` are null until a detector
// resolves them from the schedule index, so callers join on trip_id.
function getRecentMetraPositions(sinceTs) {
  return getDb()
    .prepare(`
    SELECT ts, route, vehicle_id, trip_id, lat, lon, heading
    FROM observations
    WHERE kind = 'metra' AND ts >= ? AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY ts
  `)
    .all(sinceTs);
}

// `direction` carries the pid; callers resolve to a pattern downstream.
function getBusObservations(route, sinceTs) {
  return getDb()
    .prepare(`
    SELECT ts, direction, vehicle_id, destination
    FROM observations
    WHERE kind = 'bus' AND route = ? AND ts >= ?
  `)
    .all(String(route), sinceTs);
}

// Timestamp of the most recent bus observation on this route (any pid),
// or null if the route has never been observed. Used by thin-gaps to
// stamp the firing event with the actual moment the route went silent
// rather than the 20-min cron tick that noticed.
function getLastBusObservationTs(route) {
  const row = getDb()
    .prepare(`
    SELECT MAX(ts) AS ts FROM observations
    WHERE kind = 'bus' AND route = ?
  `)
    .get(String(route));
  return row?.ts ?? null;
}

// Distinct pids (CTA `direction` field) seen for a route in the lookback.
// Used by callers that need to resolve patterns for a route without
// re-fetching the live API (alerts, pulse).
function getKnownBusPidsForRoute(route, sinceTs) {
  const rows = getDb()
    .prepare(`
    SELECT DISTINCT direction AS pid
    FROM observations
    WHERE kind = 'bus' AND route = ? AND ts >= ? AND direction IS NOT NULL
  `)
    .all(String(route), sinceTs);
  return rows.map((r) => r.pid);
}

// Detection reads exclude `approx` (synthesized) positions by default so ghost/
// pulse counts are unchanged by the unpositioned-train recovery; pass
// `includeApprox` to opt the recovered positions in. `ORDER BY ts` so callers
// that build per-vehicle tracks (event-replay export) get monotonic samples.
function getTrainObservations(line, sinceTs, { includeApprox = false } = {}) {
  return getDb()
    .prepare(`
    SELECT ts, direction, vehicle_id, destination, lat, lon
    FROM observations
    WHERE kind = 'train' AND route = ? AND ts >= ?
      ${includeApprox ? '' : 'AND (approx IS NULL OR approx = 0)'}
    ORDER BY ts
  `)
    .all(String(line), sinceTs);
}

// Returns Vehicle-shaped rows + the snapshotTs to use as `now` so the
// per-vehicle tmstmp staleness gate fires against the snapshot's clock, not
// the caller's wall clock. Null if no positioned row is fresh enough.
function getLatestBusSnapshot(routes, maxStaleMs = null, now = Date.now()) {
  if (!routes || routes.length === 0) return null;
  const placeholders = routes.map(() => '?').join(',');
  const params = routes.map(String);
  const latest = getDb()
    .prepare(`
    SELECT MAX(ts) AS ts FROM observations
    WHERE kind = 'bus' AND route IN (${placeholders}) AND pdist IS NOT NULL
  `)
    .get(...params);
  const snapshotTs = latest?.ts;
  if (!snapshotTs) return null;
  if (maxStaleMs != null && now - snapshotTs > maxStaleMs) return null;
  // Exact-ts match (vs a window) so a single fetch contributes one snapshot.
  const rows = getDb()
    .prepare(`
    SELECT route, direction AS pid, vehicle_id AS vid, destination,
           lat, lon, pdist, heading, vehicle_ts
    FROM observations
    WHERE kind = 'bus' AND route IN (${placeholders}) AND ts = ? AND pdist IS NOT NULL
  `)
    .all(...params, snapshotTs);
  const vehicles = rows.map((r) => ({
    vid: r.vid,
    route: r.route,
    pid: r.pid,
    lat: r.lat,
    lon: r.lon,
    heading: r.heading,
    pdist: r.pdist,
    destination: r.destination,
    tmstmp: r.vehicle_ts != null ? new Date(r.vehicle_ts) : new Date(snapshotTs),
  }));
  return { vehicles, snapshotTs };
}

// Returns Map<route, observation[]> for every supplied route (empty arrays
// kept so callers can iterate the watchlist without per-route absence checks).
// One SQL pass; bucketing in JS.
function getRecentBusObservationsByRoute(routes, sinceTs) {
  const result = new Map();
  if (!routes || routes.length === 0) return result;
  for (const r of routes) result.set(String(r), []);
  const placeholders = routes.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`
      SELECT ts, route, direction AS pid, vehicle_id AS vid, destination,
             lat, lon, pdist, heading, vehicle_ts
      FROM observations
      WHERE kind = 'bus' AND route IN (${placeholders}) AND ts >= ?
    `)
    .all(...routes.map(String), sinceTs);
  for (const row of rows) {
    const bucket = result.get(row.route);
    if (bucket) bucket.push(row);
  }
  return result;
}

function countDistinctTsInBusObservations(sinceTs) {
  const row = getDb()
    .prepare(`
      SELECT COUNT(DISTINCT ts) AS n
      FROM observations
      WHERE kind = 'bus' AND ts >= ?
    `)
    .get(sinceTs);
  return row?.n || 0;
}

function getRecentTrainPositions(sinceTs, { includeApprox = false } = {}) {
  return getDb()
    .prepare(`
    SELECT ts, route AS line, direction AS trDr, vehicle_id AS rn, destination, lat, lon
    FROM observations
    WHERE kind = 'train' AND ts >= ? AND lat IS NOT NULL AND lon IS NOT NULL
      ${includeApprox ? '' : 'AND (approx IS NULL OR approx = 0)'}
  `)
    .all(sinceTs);
}

// Bounding box of train observations for a given line in the past `sinceTs`
// window — used to constrain pulse detection to the actual revenue corridor
// (e.g. weekend Purple runs Linden ↔ Howard, not the full Express to Loop).
// Returns null when the line has had zero observations in the window.
// Set of bus routes that have had at least one observation since `sinceTs`.
// Used by bus-pulse's cold-start grace: a route with no obs in the past 6h
// is service-not-yet-started rather than blackout, so suppress the alert.
function getActiveBusRoutesSince(sinceTs) {
  const rows = getDb()
    .prepare(`
      SELECT DISTINCT route FROM observations
      WHERE kind = 'bus' AND ts >= ?
    `)
    .all(sinceTs);
  return new Set(rows.map((r) => String(r.route)));
}

// Used by the synthetic full-line path to name endpoints when a line goes
// fully silent — clips the polyline to current revenue track (e.g. Purple
// weekend Linden↔Howard, Yellow shuttle segment).
function getLineCorridorBbox(line, sinceTs) {
  const row = getDb()
    .prepare(`
      SELECT MIN(lat) AS minLat, MAX(lat) AS maxLat,
             MIN(lon) AS minLon, MAX(lon) AS maxLon,
             COUNT(*) AS n
      FROM observations
      WHERE kind = 'train' AND route = ? AND ts >= ?
        AND lat IS NOT NULL AND lon IS NOT NULL
        AND (approx IS NULL OR approx = 0)
    `)
    .get(line, sinceTs);
  if (!row?.n) return null;
  return { minLat: row.minLat, maxLat: row.maxLat, minLon: row.minLon, maxLon: row.maxLon };
}

module.exports = {
  recordBusObservations,
  recordTrainObservations,
  recordMetraObservations,
  recordMetraTripUpdates,
  getRecentMetraPositions,
  getMetraCanceledTrips,
  getMetraObservedTripIds,
  getMetraLivePredictionTripIds,
  getMetraSnapshotTimestamps,
  getBusObservations,
  getLastBusObservationTs,
  getKnownBusPidsForRoute,
  getTrainObservations,
  getLatestBusSnapshot,
  getRecentBusObservationsByRoute,
  countDistinctTsInBusObservations,
  getRecentTrainPositions,
  getLineCorridorBbox,
  getActiveBusRoutesSince,
  rolloffOldObservations,
};
