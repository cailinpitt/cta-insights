const test = require('node:test');
const assert = require('node:assert');
const { detectHeldBusClusters } = require('../../src/bus/heldClusters');

const NOW = 1_700_000_000_000;

function stationaryBus(vid, pid, pdist, durationMs = 30 * 60 * 1000, obsCount = 4) {
  // Default 30 min over 4 obs → 10 min between obs (matches observe-buses
  // */10 cadence). Tail of 3 obs spans 20 min, easily satisfying the
  // STATIONARY_MIN_SPAN_MS = 8 min gate.
  const out = [];
  const start = NOW - durationMs;
  for (let i = 0; i < obsCount; i++) {
    const t = start + (i * durationMs) / (obsCount - 1);
    out.push({
      ts: t,
      vehicle_id: vid,
      pid,
      pdist: pdist + i * 10,
      lat: 41.99,
      lon: -87.65,
    });
  }
  return out;
}

function movingBus(vid, pid, fromPd, toPd) {
  const out = [];
  const durationMs = 8 * 60 * 1000;
  const start = NOW - durationMs;
  const obsCount = 4;
  for (let i = 0; i < obsCount; i++) {
    const t = start + (i * durationMs) / (obsCount - 1);
    const pdist = fromPd + ((toPd - fromPd) * i) / (obsCount - 1);
    out.push({ ts: t, vehicle_id: vid, pid, pdist, lat: 41.99, lon: -87.65 });
  }
  return out;
}

test('2 stationary buses on same pid within cluster, no moving → admit', () => {
  const obs = [...stationaryBus('a', 'p1', 5000), ...stationaryBus('b', 'p1', 5800)];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].busCount, 2);
});

test('2 stationary on same pid + 1 fast-moving through cluster area → drop', () => {
  // Moving bus crosses the cluster (ends at pdist 5400 with high tail
  // displacement) → still in veto range, vetoes the cluster.
  const obs = [
    ...stationaryBus('a', 'p1', 5000),
    ...stationaryBus('b', 'p1', 5800),
    ...movingBus('c', 'p1', -10000, 5400),
  ];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(candidates.length, 0);
});

test('2 stationary on same pid + 1 fast-moving > 2640ft away → admit', () => {
  const obs = [
    ...stationaryBus('a', 'p1', 5000),
    ...stationaryBus('b', 'p1', 5800),
    ...movingBus('c', 'p1', 30000, 45000),
  ];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(candidates.length, 1);
});

test('2 stationary on same pid + 1 slow-creep bus inside cluster → admit (creep classifies as unknown)', () => {
  // A bus moving slowly (< 8000 ft tail displacement) is part of the same
  // disruption — should not veto the cluster.
  const obs = [
    ...stationaryBus('a', 'p1', 5000),
    ...stationaryBus('b', 'p1', 5800),
    ...movingBus('c', 'p1', 4000, 6500),
  ];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(candidates.length, 1, 'creeping bus should not veto held cluster');
});

test('insufficient duration → drop', () => {
  const obs = [
    ...stationaryBus('a', 'p1', 5000, 5 * 60 * 1000),
    ...stationaryBus('b', 'p1', 5800, 5 * 60 * 1000),
  ];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(candidates.length, 0);
});

test('1 stationary bus alone → drop', () => {
  const obs = [...stationaryBus('a', 'p1', 5000)];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(candidates.length, 0);
});

test('stationary buses on DIFFERENT pids → drop (not the same direction of travel)', () => {
  const obs = [...stationaryBus('a', 'p1', 5000), ...stationaryBus('b', 'p2', 5800)];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(candidates.length, 0);
});

test('cluster with 3 buses on same pid → busCount = 3 admits', () => {
  const obs = [
    ...stationaryBus('a', 'p1', 5000),
    ...stationaryBus('b', 'p1', 5400),
    ...stationaryBus('c', 'p1', 5900),
  ];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].busCount, 3);
});

test('headway scaling: 20-min headway requires 30 min stationary', () => {
  const obs = [
    ...stationaryBus('a', 'p1', 5000, 20 * 60 * 1000),
    ...stationaryBus('b', 'p1', 5800, 20 * 60 * 1000),
  ];
  const { candidates } = detectHeldBusClusters({
    route: '147',
    observations: obs,
    headwayMin: 20,
    now: NOW,
  });
  assert.equal(candidates.length, 0, '20 min not enough at 20-min headway (1.5x = 30min)');
});

test('no observations → skipped', () => {
  const out = detectHeldBusClusters({
    route: '147',
    observations: [],
    headwayMin: 8,
    now: NOW,
  });
  assert.equal(out.skipped, 'no-input');
});
