const { getDb } = require('./history');

const ROLLOFF_MS = 3 * 60 * 60 * 1000; // 3h — ghost job looks back at most 1h; keep a cushion

let _ensured = false;
function ensureSchema() {
  if (_ensured) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS observations (
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      route TEXT NOT NULL,
      direction TEXT,
      vehicle_id TEXT NOT NULL,
      destination TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_obs_kind_route_ts
      ON observations(kind, route, ts);
  `);
  _ensured = true;
}

function rolloffOldObservations(now = Date.now()) {
  ensureSchema();
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
    ensureSchema();
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
    ensureSchema();
    const stmt = getDb().prepare(`
      INSERT INTO observations (ts, kind, route, direction, vehicle_id, destination)
      VALUES (?, 'train', ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const t of items) {
        if (!t.rn || !t.line) continue;
        stmt.run(now, String(t.line), t.trDr != null ? String(t.trDr) : null, String(t.rn), t.destination || null);
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
  ensureSchema();
  return getDb().prepare(`
    SELECT ts, direction, vehicle_id, destination
    FROM observations
    WHERE kind = 'bus' AND route = ? AND ts >= ?
  `).all(String(route), sinceTs);
}

function getTrainObservations(line, sinceTs) {
  ensureSchema();
  return getDb().prepare(`
    SELECT ts, direction, vehicle_id, destination
    FROM observations
    WHERE kind = 'train' AND route = ? AND ts >= ?
  `).all(String(line), sinceTs);
}

module.exports = {
  recordBusObservations,
  recordTrainObservations,
  getBusObservations,
  getTrainObservations,
  rolloffOldObservations,
};
