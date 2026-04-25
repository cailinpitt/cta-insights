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
      INSERT INTO observations (ts, kind, route, direction, vehicle_id, destination)
      VALUES (?, 'bus', ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const v of items) {
        if (!v.vid || !v.route) continue;
        stmt.run(now, String(v.route), v.pid != null ? String(v.pid) : null, String(v.vid), v.destination || null);
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
  getRecentTrainPositions,
  rolloffOldObservations,
};
