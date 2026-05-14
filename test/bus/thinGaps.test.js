const test = require('node:test');
const assert = require('node:assert/strict');
const { detectThinGaps } = require('../../src/bus/thinGaps');

const NOW = 1_800_000_000_000;

function mkSched({ headway, active = 1, priorActive = 1, nextActive = 1 }) {
  return {
    getHeadway: () => headway,
    getActiveTrips: () => active,
    getPriorHourActiveTrips: () => priorActive,
    getNextHourActiveTrips: () => nextActive,
  };
}

test('fires when the window is empty and ≥2 trips are scheduled to fit', () => {
  const events = detectThinGaps({
    routes: ['31'],
    getObservations: () => [],
    now: NOW,
    ...mkSched({ headway: 25 }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '31');
  // 25 min headway → window = max(50, 60) = 60 min → 2 trips fit
  assert.equal(events[0].windowMin, 60);
  assert.equal(events[0].missedTrips, 2);
});

test('stays silent when any observation lands in the window', () => {
  const drops = [];
  const events = detectThinGaps({
    routes: ['31'],
    getObservations: () => [{ ts: NOW - 10 * 60_000, direction: 'p1' }],
    now: NOW,
    onDrop: (d) => drops.push(d),
    ...mkSched({ headway: 25 }),
  });
  assert.equal(events.length, 0);
  assert.equal(drops[0].reason, 'observed');
});

test('skips routes with expectedActiveTrips ≤ 0 (route not scheduled)', () => {
  const drops = [];
  const events = detectThinGaps({
    routes: ['125'],
    getObservations: () => [],
    now: NOW,
    onDrop: (d) => drops.push(d),
    ...mkSched({ headway: 20, active: 0 }),
  });
  assert.equal(events.length, 0);
  assert.equal(drops[0].reason, 'not_scheduled');
});

test('skips routes with unknown headway', () => {
  const drops = [];
  const events = detectThinGaps({
    routes: ['31'],
    getObservations: () => [],
    now: NOW,
    onDrop: (d) => drops.push(d),
    ...mkSched({ headway: null }),
  });
  assert.equal(events.length, 0);
  assert.equal(drops[0].reason, 'no_headway');
});

test('severity caps at 1 once 3+ trips are missed', () => {
  // Long-headway route doesn't easily fit 3 trips in a 60-min window, so use
  // a 30-min headway: window = 60 min, 2 missed → severity 2/3.
  const events30 = detectThinGaps({
    routes: ['96'],
    getObservations: () => [],
    now: NOW,
    ...mkSched({ headway: 30 }),
  });
  assert.equal(events30[0].missedTrips, 2);
  assert.ok(Math.abs(events30[0].severity - 2 / 3) < 1e-9);

  // A 20-min route: window = max(40, 60) = 60 min, 3 missed → severity 1.
  const events20 = detectThinGaps({
    routes: ['100'],
    getObservations: () => [],
    now: NOW,
    ...mkSched({ headway: 20 }),
  });
  assert.equal(events20[0].missedTrips, 3);
  assert.equal(events20[0].severity, 1);
});

test('window grows past 60 min when 2× headway exceeds the floor', () => {
  // 45-min headway: 2× = 90 min, beats 60-min floor.
  const events = detectThinGaps({
    routes: ['rare'],
    getObservations: () => [],
    now: NOW,
    ...mkSched({ headway: 45 }),
  });
  assert.equal(events[0].windowMin, 90);
  assert.equal(events[0].missedTrips, 2);
});

test('skips at ramp-up (current hour active but prior hour was not)', () => {
  const drops = [];
  const events = detectThinGaps({
    routes: ['100'],
    getObservations: () => [],
    now: NOW,
    onDrop: (d) => drops.push(d),
    ...mkSched({ headway: 20, active: 1, priorActive: 0 }),
  });
  assert.equal(events.length, 0);
  assert.equal(drops[0].reason, 'ramp_up');
});

test('skips at wind-down (current hour active but next hour will not be)', () => {
  const drops = [];
  const events = detectThinGaps({
    routes: ['100'],
    getObservations: () => [],
    now: NOW,
    onDrop: (d) => drops.push(d),
    ...mkSched({ headway: 20, active: 1, nextActive: 0 }),
  });
  assert.equal(events.length, 0);
  assert.equal(drops[0].reason, 'wind_down');
});

test('getObservations is called with the window start derived from headway', () => {
  let receivedSince = null;
  detectThinGaps({
    routes: ['31'],
    getObservations: (_route, since) => {
      receivedSince = since;
      return [];
    },
    now: NOW,
    ...mkSched({ headway: 20 }),
  });
  // 20 min × 2 = 40 < 60 floor → window = 60 min
  assert.equal(NOW - receivedSince, 60 * 60_000);
});
