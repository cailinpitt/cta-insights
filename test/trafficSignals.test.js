const test = require('node:test');
const assert = require('node:assert/strict');
const { filterSignalsOnRoute, dedupeNearbySignals, annotateSignalOrientations } = require('../src/bus/trafficSignals');
const { pointAtFt } = require('./helpers');

// A straight N-S route: 10 points along lon=-87.65, spanning 10000 ft.
const route = [];
for (let i = 0; i <= 10; i++) route.push(pointAtFt(10000, i * 1000));

test('filterSignalsOnRoute keeps signals on the line and drops far ones', () => {
  const onLine = pointAtFt(10000, 3000);
  const near = { lat: onLine.lat, lon: onLine.lon + 0.0001 }; // ~27 ft east
  const far = { lat: onLine.lat, lon: onLine.lon + 0.003 };  // ~810 ft east
  const kept = filterSignalsOnRoute([onLine, near, far], route, 120);
  assert.equal(kept.length, 2);
  assert.ok(!kept.includes(far));
});

test('filterSignalsOnRoute threshold is configurable', () => {
  const p = pointAtFt(10000, 5000);
  const offset = { lat: p.lat, lon: p.lon + 0.0008 }; // ~220 ft east
  assert.equal(filterSignalsOnRoute([offset], route, 120).length, 0);
  assert.equal(filterSignalsOnRoute([offset], route, 300).length, 1);
});

test('dedupeNearbySignals collapses clusters within minFt to one', () => {
  // 4 signals within a ~40 ft box — one intersection tagged at all 4 corners.
  const base = pointAtFt(10000, 5000);
  const cluster = [
    base,
    { lat: base.lat + 0.00005, lon: base.lon },
    { lat: base.lat, lon: base.lon + 0.00005 },
    { lat: base.lat + 0.00005, lon: base.lon + 0.00005 },
  ];
  const kept = dedupeNearbySignals(cluster, 150);
  assert.equal(kept.length, 1);
});

test('dedupeNearbySignals preserves signals beyond minFt', () => {
  const a = pointAtFt(10000, 2000);
  const b = pointAtFt(10000, 4000); // 2000 ft away
  const c = pointAtFt(10000, 6000); // 2000 ft further
  const kept = dedupeNearbySignals([a, b, c], 150);
  assert.equal(kept.length, 3);
});

test('annotateSignalOrientations marks E-W routes vertical and N-S routes horizontal', () => {
  const ewRoute = [{ lat: 41.896, lon: -87.65 }, { lat: 41.896, lon: -87.64 }];
  const nsRoute = [{ lat: 41.90, lon: -87.687 }, { lat: 41.91, lon: -87.687 }];
  const ew = annotateSignalOrientations([{ lat: 41.896, lon: -87.645 }], ewRoute);
  const ns = annotateSignalOrientations([{ lat: 41.905, lon: -87.687 }], nsRoute);
  assert.equal(ew[0].orientation, 'vertical');
  assert.equal(ns[0].orientation, 'horizontal');
});

test('annotateSignalOrientations snaps signals to the nearest point on the route', () => {
  // Straight N-S route along lon=-87.687. Two signals offset east/west by
  // ~50 ft each — after snapping they should both sit on the centerline.
  const route = [{ lat: 41.90, lon: -87.687 }, { lat: 41.91, lon: -87.687 }];
  const offsets = [
    { lat: 41.905, lon: -87.6872 },
    { lat: 41.906, lon: -87.6868 },
  ];
  const snapped = annotateSignalOrientations(offsets, route);
  for (const s of snapped) assert.ok(Math.abs(s.lon - -87.687) < 1e-9);
});
