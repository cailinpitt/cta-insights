const { getDb } = require('./history');

// Detection only looks back ~1h, but 48h covers two service days for post-hoc
// investigation of flagged events.
const ROLLOFF_MS = 48 * 60 * 60 * 1000;

function rolloffOldObservations(now = Date.now()) {
  getDb().prepare('DELETE FROM observations WHERE ts < ?').run(now - ROLLOFF_MS);
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

// `direction` carries the pid; callers resolve to a pattern downstream.
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

// Returns Vehicle-shaped rows + the snapshotTs to use as `now` so the
// per-vehicle tmstmp staleness gate fires against the snapshot's clock, not
// the caller's wall clock. Null if no positioned row is fresh enough.
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
  // Exact-ts match (vs a window) so a single fetch contributes one snapshot.
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
