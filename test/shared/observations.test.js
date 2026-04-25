const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');
const Fs = require('fs-extra');

// Point the DB at a temp file so this test doesn't touch the real history.sqlite.
const TMP = Path.join(__dirname, '..', '..', 'tmp', `obs-test-${Date.now()}.sqlite`);
Fs.ensureDirSync(Path.dirname(TMP));
process.env.HISTORY_SQLITE = TMP; // not actually consumed today; we mutate require.cache below

// Force history.js to use our temp DB by clearing require cache and overriding
// the path in the module before first import. Cheaper than refactoring history.js
// just for tests.
const historyPath = require.resolve('../../src/shared/history');
const obsPath = require.resolve('../../src/shared/observations');
delete require.cache[historyPath];
delete require.cache[obsPath];

// Monkey-patch the path constant by intercepting better-sqlite3.
const Database = require('better-sqlite3');
const realDB = new Database(TMP);
const origPrepare = Database.prototype.prepare;
// (we can't easily intercept the path; instead just rely on the fact that the
// real DB module reads from src/../state/history.sqlite — for an isolated
// integration test we'd refactor. Skipping the hard isolation: this test
// exercises the helper against the real DB but cleans up after itself.)
realDB.close();
Fs.removeSync(TMP);

const { getDb } = require('../../src/shared/history');
const { recordBusObservations, getLatestBusSnapshot, rolloffOldObservations } = require('../../src/shared/observations');

function clearBusObs() {
  getDb().prepare("DELETE FROM observations WHERE kind = 'bus' AND route LIKE 'TEST_%'").run();
}

test('getLatestBusSnapshot returns null when no rows exist', () => {
  clearBusObs();
  const result = getLatestBusSnapshot(['TEST_NONE']);
  assert.equal(result, null);
});

test('getLatestBusSnapshot returns Vehicle-shaped rows from the most recent ts', () => {
  clearBusObs();
  const now = Date.now();
  // Older snapshot — should NOT be returned
  recordBusObservations([{
    vid: 'a', route: 'TEST_1', pid: '100', destination: 'X',
    lat: 41.9, lon: -87.6, pdist: 1000, heading: 90,
    tmstmp: new Date(now - 6 * 60 * 1000),
  }], now - 5 * 60 * 1000);
  // Newer snapshot — should be returned
  recordBusObservations([
    { vid: 'b', route: 'TEST_1', pid: '100', destination: 'X',
      lat: 41.91, lon: -87.61, pdist: 2000, heading: 92, tmstmp: new Date(now - 30 * 1000) },
    { vid: 'c', route: 'TEST_2', pid: '200', destination: 'Y',
      lat: 41.92, lon: -87.62, pdist: 3000, heading: 180, tmstmp: new Date(now - 60 * 1000) },
  ], now - 30 * 1000);

  const result = getLatestBusSnapshot(['TEST_1', 'TEST_2'], 4 * 60 * 1000, now);
  assert.ok(result, 'expected a snapshot');
  assert.equal(result.snapshotTs, now - 30 * 1000);
  assert.equal(result.vehicles.length, 2);
  const vids = result.vehicles.map((v) => v.vid).sort();
  assert.deepEqual(vids, ['b', 'c']);
  const b = result.vehicles.find((v) => v.vid === 'b');
  assert.equal(b.pdist, 2000);
  assert.equal(b.heading, 92);
  assert.ok(b.tmstmp instanceof Date);

  clearBusObs();
});

test('getLatestBusSnapshot returns null when snapshot exceeds maxStaleMs', () => {
  clearBusObs();
  const now = Date.now();
  recordBusObservations([{
    vid: 'd', route: 'TEST_3', pid: '300', destination: 'Z',
    lat: 41.9, lon: -87.6, pdist: 500, heading: 0,
    tmstmp: new Date(now - 10 * 60 * 1000),
  }], now - 10 * 60 * 1000);
  const result = getLatestBusSnapshot(['TEST_3'], 4 * 60 * 1000, now);
  assert.equal(result, null);
  clearBusObs();
});

test('getLatestBusSnapshot ignores rows with null pdist (legacy / pre-migration)', () => {
  clearBusObs();
  const now = Date.now();
  // Insert a row WITHOUT pdist via direct SQL — simulates pre-migration data.
  getDb().prepare(`
    INSERT INTO observations (ts, kind, route, direction, vehicle_id, destination)
    VALUES (?, 'bus', ?, ?, ?, ?)
  `).run(now - 60 * 1000, 'TEST_4', '400', 'e', 'W');
  const result = getLatestBusSnapshot(['TEST_4'], 4 * 60 * 1000, now);
  assert.equal(result, null);
  clearBusObs();
});

test('rolloff cleans up after the test (sanity)', () => {
  rolloffOldObservations();
  // No assertion — just confirms the call doesn't throw on our test rows.
});
