const { getDb } = require('./history');

// Detection only looks back ~1h, but 48h covers two service days for post-hoc
// investigation of flagged events.
const ROLLOFF_MS = 48 * 60 * 60 * 1000;

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
      INSERT INTO observations (ts, kind, route, direction, vehicle_id, destination, lat, lon)
      VALUES (?, 'train', ?, ?, ?, ?, ?, ?)
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
  return getDb()
    .prepare(`
    SELECT ts, direction, vehicle_id, destination
    FROM observations
    WHERE kind = 'bus' AND route = ? AND ts >= ?
  `)
    .all(String(route), sinceTs);
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

function getTrainObservations(line, sinceTs) {
  return getDb()
    .prepare(`
    SELECT ts, direction, vehicle_id, destination, lat, lon
    FROM observations
    WHERE kind = 'train' AND route = ? AND ts >= ?
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

function getRecentTrainPositions(sinceTs) {
  return getDb()
    .prepare(`
    SELECT ts, route AS line, direction AS trDr, vehicle_id AS rn, lat, lon
    FROM observations
    WHERE kind = 'train' AND ts >= ? AND lat IS NOT NULL AND lon IS NOT NULL
  `)
    .all(sinceTs);
}

// Bounding box of train observations for a given line in the past `sinceTs`
// window — used to constrain pulse detection to the actual revenue corridor
// (e.g. weekend Purple runs Linden ↔ Howard, not the full Express to Loop).
// Returns null when the line has had zero observations in the window.
function getLineCorridorBbox(line, sinceTs) {
  const row = getDb()
    .prepare(`
      SELECT MIN(lat) AS minLat, MAX(lat) AS maxLat,
             MIN(lon) AS minLon, MAX(lon) AS maxLon,
             COUNT(*) AS n
      FROM observations
      WHERE kind = 'train' AND route = ? AND ts >= ?
        AND lat IS NOT NULL AND lon IS NOT NULL
    `)
    .get(line, sinceTs);
  if (!row || !row.n) return null;
  return { minLat: row.minLat, maxLat: row.maxLat, minLon: row.minLon, maxLon: row.maxLon };
}

module.exports = {
  recordBusObservations,
  recordTrainObservations,
  getBusObservations,
  getKnownBusPidsForRoute,
  getTrainObservations,
  getLatestBusSnapshot,
  getRecentBusObservationsByRoute,
  countDistinctTsInBusObservations,
  getRecentTrainPositions,
  getLineCorridorBbox,
  rolloffOldObservations,
};
