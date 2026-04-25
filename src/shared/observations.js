const { getDb } = require('./history');

// Observations table is ensured by history.js on first DB open.
// Ghost detection only looks back 1h, but we keep a much larger window so we
// can post-hoc investigate flagged events (trace which specific vehicle_ids
// disappeared and when). 48h covers two full service days.
const ROLLOFF_MS = 48 * 60 * 60 * 1000;

function rolloffOldObservations(now = Date.now()) {
  getDb().prepare('DELETE FROM observations WHERE ts < ?').run(now - ROLLOFF_MS);
}

/**
 * Record bus vehicle observations. `vehicles` is the output of `getVehicles`
 * (objects with vid, route, pid). Swallows DB errors so API callers aren't
 * broken by a logger issue.
 */
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

/**
 * Record train observations. `trains` is the output of `getAllTrainPositions`
 * (objects with rn, line, trDr, destination).
 */
function recordTrainObservations(trains, now = Date.now()) {
  if (!trains || trains.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO observations (ts, kind, route, direction, vehicle_id, destination, lat, lon)
      VALUES (?, 'train', ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const t of items) {
        if (!t.rn || !t.line) continue;
        stmt.run(
          now, String(t.line),
          t.trDr != null ? String(t.trDr) : null,
          String(t.rn),
          t.destination || null,
          Number.isFinite(t.lat) ? t.lat : null,
          Number.isFinite(t.lon) ? t.lon : null,
        );
      }
    });
    tx(trains);
  } catch (e) {
    console.warn(`recordTrainObservations failed: ${e.message}`);
  }
}

/**
 * Fetch bus observations on a route since `sinceTs`. Returned rows carry pid
 * (as `direction`) so callers can resolve per-pattern direction downstream.
 */
function getBusObservations(route, sinceTs) {
  return getDb().prepare(`
    SELECT ts, direction, vehicle_id, destination
    FROM observations
    WHERE kind = 'bus' AND route = ? AND ts >= ?
  `).all(String(route), sinceTs);
}

function getTrainObservations(line, sinceTs) {
  return getDb().prepare(`
    SELECT ts, direction, vehicle_id, destination, lat, lon
    FROM observations
    WHERE kind = 'train' AND route = ? AND ts >= ?
  `).all(String(line), sinceTs);
}

/**
 * Latest bus snapshot for the given routes — i.e. the rows written by the most
 * recent observeGhosts (or any other) call that fetched these routes. Returns
 * Vehicle-shaped objects (so `detectAllBunching` / `detectAllGaps` consume
 * them unchanged) plus the `snapshotTs` (the cron's `now` when those rows
 * were written) so callers can pass it through as `now` and the per-vehicle
 * `tmstmp` staleness gate stays accurate.
 *
 * Returns `null` if no positioned observation exists for any of the routes
 * within `maxStaleMs`. Caller should fall back to a fresh `getVehicles` fetch.
 *
 * The snapshot is the latest `ts` we have for any of the requested routes.
 * If a single route's most recent observation is older than `maxStaleMs`, we
 * still consume what's available — the per-vehicle `tmstmp` gate in the
 * detector filters out individual stale buses, and missing recent data on
 * one route is not a reason to throw away fresh data on the others.
 */
function getLatestBusSnapshot(routes, maxStaleMs = null, now = Date.now()) {
  if (!routes || routes.length === 0) return null;
  const placeholders = routes.map(() => '?').join(',');
  const params = routes.map(String);
  const latest = getDb().prepare(`
    SELECT MAX(ts) AS ts FROM observations
    WHERE kind = 'bus' AND route IN (${placeholders}) AND pdist IS NOT NULL
  `).get(...params);
  const snapshotTs = latest && latest.ts;
  if (!snapshotTs) return null;
  if (maxStaleMs != null && now - snapshotTs > maxStaleMs) return null;
  // Pull every row from the snapshot's exact ts. Using the exact ts (vs a
  // window) means a single fetch contributes one snapshot — matches the
  // semantics observers were already producing.
  const rows = getDb().prepare(`
    SELECT route, direction AS pid, vehicle_id AS vid, destination,
           lat, lon, pdist, heading, vehicle_ts
    FROM observations
    WHERE kind = 'bus' AND route IN (${placeholders}) AND ts = ? AND pdist IS NOT NULL
  `).all(...params, snapshotTs);
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

/**
 * Recent positioned observations across all train lines since `sinceTs`.
 * Only rows with non-null lat/lon are returned — used by the pulse detector
 * which needs to project historical positions onto line polylines.
 */
function getRecentTrainPositions(sinceTs) {
  return getDb().prepare(`
    SELECT ts, route AS line, direction AS trDr, vehicle_id AS rn, lat, lon
    FROM observations
    WHERE kind = 'train' AND ts >= ? AND lat IS NOT NULL AND lon IS NOT NULL
  `).all(sinceTs);
}

module.exports = {
  recordBusObservations,
  recordTrainObservations,
  getBusObservations,
  getTrainObservations,
  getLatestBusSnapshot,
  getRecentTrainPositions,
  rolloffOldObservations,
};
