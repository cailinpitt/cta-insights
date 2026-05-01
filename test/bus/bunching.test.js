const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectAllBunching,
  detectBunching,
  BUNCHING_THRESHOLD_FT,
} = require('../../src/bus/bunching');
const { bus, FRESH } = require('../helpers');

test('detects a pair within the threshold', () => {
  const vs = [bus({ vid: 'a', pdist: 5000 }), bus({ vid: 'b', pdist: 5500 })];
  const [bunch] = detectAllBunching(vs, FRESH);
  assert.equal(bunch.vehicles.length, 2);
  assert.equal(bunch.spanFt, 500);
});

test('ignores pairs farther apart than the threshold', () => {
  const vs = [
    bus({ vid: 'a', pdist: 5000 }),
    bus({ vid: 'b', pdist: 5000 + BUNCHING_THRESHOLD_FT + 1 }),
  ];
  assert.equal(detectAllBunching(vs, FRESH).length, 0);
});

test('extends a cluster past pairs', () => {
  const vs = [
    bus({ vid: 'a', pdist: 5000 }),
    bus({ vid: 'b', pdist: 5400 }),
    bus({ vid: 'c', pdist: 5900 }),
  ];
  const [bunch] = detectAllBunching(vs, FRESH);
  assert.equal(bunch.vehicles.length, 3);
  assert.equal(bunch.spanFt, 900);
  assert.equal(bunch.maxGapFt, 500);
});

test('drops stale vehicles (older than STALE_MS)', () => {
  const vs = [
    bus({ vid: 'a', pdist: 5000 }),
    bus({ vid: 'b', pdist: 5500, tmstmp: FRESH - 5 * 60 * 1000 }),
  ];
  assert.equal(detectAllBunching(vs, FRESH).length, 0);
});

test('skips clusters inside the start-terminal zone', () => {
  const vs = [bus({ vid: 'a', pdist: 100 }), bus({ vid: 'b', pdist: 400 })];
  assert.equal(detectAllBunching(vs, FRESH).length, 0);
});

test('groups by pid so different patterns do not merge', () => {
  const vs = [
    bus({ vid: 'a', pid: '100', pdist: 5000 }),
    bus({ vid: 'b', pid: '200', pdist: 5200 }),
  ];
  assert.equal(detectAllBunching(vs, FRESH).length, 0);
});

test('ranks by size desc then tighter max gap', () => {
  const vs = [
    // Pattern 100: 3-bus cluster with 800ft max gap
    bus({ vid: 'a', pid: '100', pdist: 5000 }),
    bus({ vid: 'b', pid: '100', pdist: 5800 }),
    bus({ vid: 'c', pid: '100', pdist: 6400 }),
    // Pattern 200: tighter 2-bus cluster
    bus({ vid: 'd', pid: '200', pdist: 5000 }),
    bus({ vid: 'e', pid: '200', pdist: 5100 }),
  ];
  const bunches = detectAllBunching(vs, FRESH);
  assert.equal(bunches[0].pid, '100');
  assert.equal(bunches[0].vehicles.length, 3);
});

test('detectBunching returns the single top-ranked bunch', () => {
  const vs = [bus({ vid: 'a', pdist: 5000 }), bus({ vid: 'b', pdist: 5300 })];
  const bunch = detectBunching(vs, FRESH);
  assert.equal(bunch.vehicles.length, 2);
});

test('rejects cluster when one bus is geographically far despite matching pdist', () => {
  // Real-world J14 incident: CTA reported stale pdist for a bus that had
  // already laid over and started a new run, putting it miles from the
  // others while pdist still matched.
  const vs = [
    bus({ vid: 'a', pdist: 34619, lat: 41.7758, lon: -87.575 }),
    bus({ vid: 'b', pdist: 34866, lat: 41.7764, lon: -87.5752 }),
    bus({ vid: 'c', pdist: 34415, lat: 41.8819, lon: -87.6305 }), // ~7 mi away
  ];
  assert.equal(detectAllBunching(vs, FRESH).length, 0);
});

test('still detects a real bunch with normal GPS jitter', () => {
  // ~500 ft apart geographically, pdist 400 ft apart — slack covers it.
  const vs = [
    bus({ vid: 'a', pdist: 5000, lat: 41.9, lon: -87.65 }),
    bus({ vid: 'b', pdist: 5400, lat: 41.9013, lon: -87.65 }),
  ];
  const [bunch] = detectAllBunching(vs, FRESH);
  assert.equal(bunch.vehicles.length, 2);
});

test('returns null/empty when nothing qualifies', () => {
  assert.equal(detectBunching([bus({ vid: 'a', pdist: 5000 })], FRESH), null);
  assert.deepEqual(detectAllBunching([], FRESH), []);
});
