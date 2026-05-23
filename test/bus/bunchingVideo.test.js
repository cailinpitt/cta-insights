const test = require('node:test');
const assert = require('node:assert');
const { fillInteriorGaps, attachTrails } = require('../../src/bus/bunchingVideo');

// Cartesian mode (hasPolyline: false) keeps the math simple: positions
// interpolate linearly in lat/lon by timestamp fraction.
const GEOM = { linePts: [], lineCum: [], hasPolyline: false };

function snap(ts, vehicles) {
  return { ts, vehicles };
}

test('fillInteriorGaps: single missed poll is interpolated, not frozen', () => {
  const snapshots = [
    snap(0, [{ vid: 'A', lat: 0, lon: 0, heading: 90, pdist: 100 }]),
    snap(15, []), // A dropped this tick
    snap(30, [{ vid: 'A', lat: 0, lon: 2, heading: 90, pdist: 300 }]),
  ];
  const filled = fillInteriorGaps(snapshots, GEOM);
  assert.equal(filled, 1);
  const mid = snapshots[1].vehicles.find((v) => v.vid === 'A');
  assert.ok(mid, 'A synthesized into the gap snapshot');
  assert.equal(mid.lon, 1, 'lon interpolated to the midpoint by ts fraction');
  assert.equal(mid.filled, true);
});

test('fillInteriorGaps: multi-poll gap is fully filled so the bus never vanishes', () => {
  // Models the route 3 #8940 dropout: present, gone for several ticks, back.
  const snapshots = [
    snap(0, [{ vid: 'A', lat: 0, lon: 0, heading: 0, pdist: 0 }]),
    snap(15, []),
    snap(30, []),
    snap(45, []),
    snap(60, [{ vid: 'A', lat: 0, lon: 4, heading: 0, pdist: 0 }]),
  ];
  const filled = fillInteriorGaps(snapshots, GEOM);
  assert.equal(filled, 3);
  for (let i = 1; i <= 3; i++) {
    const v = snapshots[i].vehicles.find((x) => x.vid === 'A');
    assert.ok(v, `A present in interior snapshot ${i}`);
    assert.equal(v.lon, i, `lon glides across the gap at snapshot ${i}`);
  }
});

test('fillInteriorGaps: trailing gap is left for tail-drop ghost handling', () => {
  const snapshots = [
    snap(0, [{ vid: 'A', lat: 0, lon: 0 }]),
    snap(15, [{ vid: 'A', lat: 0, lon: 1 }]),
    snap(30, []), // A drops and never returns — tail drop, not interior
  ];
  const filled = fillInteriorGaps(snapshots, GEOM);
  assert.equal(filled, 0);
  assert.equal(snapshots[2].vehicles.length, 0);
});

test('fillInteriorGaps: leading absence (before first sighting) is not backfilled', () => {
  const snapshots = [
    snap(0, []), // A not yet seen
    snap(15, [{ vid: 'A', lat: 0, lon: 1 }]),
    snap(30, [{ vid: 'A', lat: 0, lon: 2 }]),
  ];
  const filled = fillInteriorGaps(snapshots, GEOM);
  assert.equal(filled, 0);
  assert.equal(snapshots[0].vehicles.length, 0);
});

test('fillInteriorGaps: independent gaps across multiple vehicles', () => {
  const snapshots = [
    snap(0, [
      { vid: 'A', lat: 0, lon: 0 },
      { vid: 'B', lat: 1, lon: 0 },
    ]),
    snap(15, [{ vid: 'B', lat: 1, lon: 1 }]), // A gone
    snap(30, [
      { vid: 'A', lat: 0, lon: 2 },
      { vid: 'B', lat: 1, lon: 2 },
    ]),
  ];
  const filled = fillInteriorGaps(snapshots, GEOM);
  assert.equal(filled, 1, 'only A had an interior gap');
  const a = snapshots[1].vehicles.find((v) => v.vid === 'A');
  assert.ok(a && a.lon === 1);
});

test('attachTrails: builds oldest->newest trail spanning the window', () => {
  const vehicleFrames = [
    [{ vid: 'A', lat: 0, lon: 0 }],
    [{ vid: 'A', lat: 0, lon: 1 }],
    [{ vid: 'A', lat: 0, lon: 2 }],
    [{ vid: 'A', lat: 0, lon: 3 }],
  ];
  attachTrails(vehicleFrames, 2); // up to 2 prior frames
  const last = vehicleFrames[3][0];
  assert.deepEqual(
    last.trail.map((p) => p.lon),
    [1, 2, 3],
    'trail covers frames [i-2 .. i], head last',
  );
  // First frame has no prior positions -> no trail.
  assert.equal(vehicleFrames[0][0].trail, undefined);
});

test('attachTrails: skips parked turnaround markers', () => {
  const vehicleFrames = [
    [{ vid: 'A', lat: 0, lon: 0 }],
    [{ vid: 'A', lat: 0, lon: 1, turnaround: true }],
  ];
  attachTrails(vehicleFrames, 5);
  assert.equal(vehicleFrames[1][0].trail, undefined, 'parked marker gets no trail');
});
