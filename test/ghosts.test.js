const test = require('node:test');
const assert = require('node:assert/strict');
const { detectBusGhosts, buildRollupPost, MIN_SNAPSHOTS } = require('../src/ghosts');

// Build a synthetic observation stream: `snapshots` polling timestamps, and at
// each one, `vidsPerSnapshot` distinct vids sharing `pid`. Used to shape
// observed_active to a desired value.
function buildObs({ pid, snapshots, vidsPerSnapshot, startTs = 1_700_000_000_000, intervalMs = 5 * 60 * 1000 }) {
  const rows = [];
  for (let i = 0; i < snapshots; i++) {
    const ts = startTs + i * intervalMs;
    for (let v = 0; v < vidsPerSnapshot; v++) {
      rows.push({ ts, direction: pid, vehicle_id: `v${v}`, destination: null });
    }
  }
  return rows;
}

function mkPattern(label, route = '66') { return { pid: `p-${label}-${route}`, direction: label, route }; }

test('flags a route+direction with observed below expected by both thresholds', async () => {
  // Expected active: duration 60 / headway 10 = 6. Observed: 3. Missing: 3 (=50%).
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 3 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '66');
  assert.equal(events[0].direction, 'Eastbound');
  assert.equal(events[0].expectedActive, 6);
  assert.equal(events[0].observedActive, 3);
  assert.equal(events[0].missing, 3);
});

test('suppresses events under the absolute-missing threshold', async () => {
  // Expected 6, observed 4, missing 2 — passes 25% percent gate but fails ≥3 absolute.
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 4 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('suppresses events under the 25% gate even when ≥3 missing in absolute terms', async () => {
  // Expected 15, observed 12, missing 3 — 20% missing. Fails percent gate.
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 12 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 4,   // headway 4, duration 60 → expected 15
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('skips routes with fewer than MIN_SNAPSHOTS in the window', async () => {
  const obs = buildObs({ pid: 'p1', snapshots: MIN_SNAPSHOTS - 1, vidsPerSnapshot: 1 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('merges observations from multiple pids when they resolve to the same direction', async () => {
  // Two weekday pids both labeled "Eastbound" — their observations should be
  // combined into a single direction group. Each pid provides 2 vids; the
  // merged snapshot should show 4 distinct vids.
  const rows = [
    ...buildObs({ pid: 'p-weekday', snapshots: 12, vidsPerSnapshot: 2 }),
    ...buildObs({ pid: 'p-express', snapshots: 12, vidsPerSnapshot: 2 }).map((r, i) => ({ ...r, vehicle_id: `x${i % 2}` })),
  ];
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => rows,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 6,     // expected active = 60/6 = 10, missing = 6
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].observedActive, 4);
  assert.equal(events[0].expectedActive, 10);
});

test('skips when expected active count is below 2 (too sparse to be newsworthy)', async () => {
  // Headway 40, duration 60 → expected 1.5. Below the 2-vehicle floor.
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 0 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 40,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('skips routes where headway or duration is null', async () => {
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 1 });
  const noHeadway = await detectBusGhosts({
    routes: ['66'], getObservations: () => obs, getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => null, expectedDuration: () => 60,
  });
  assert.equal(noHeadway.length, 0);
  const noDuration = await detectBusGhosts({
    routes: ['66'], getObservations: () => obs, getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10, expectedDuration: () => null,
  });
  assert.equal(noDuration.length, 0);
});

test('buildRollupPost keeps all lines when they fit under the limit', () => {
  const lines = ['a', 'b', 'c'];
  const text = buildRollupPost('head', lines, 100);
  assert.equal(text, 'head\na\nb\nc');
});

test('buildRollupPost appends "…and N more routes" when truncating', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line number ${i} padded to fit`);
  const text = buildRollupPost('HEAD', lines, 120);
  assert.ok(text.length <= 120, `expected <= 120, got ${text.length}`);
  assert.match(text, /…and \d+ more routes?/);
  const dropped = Number(text.match(/…and (\d+) more/)[1]);
  const kept = lines.length - dropped;
  for (let i = 0; i < kept; i++) assert.ok(text.includes(lines[i]));
});

test('buildRollupPost returns null when no line fits', () => {
  const text = buildRollupPost('HEAD', ['a-very-long-single-line'], 10);
  assert.equal(text, null);
});

test('buildRollupPost uses singular "route" when exactly 1 is dropped', () => {
  // 3 lines × 40 chars. Full rollup = 1+1+40+1+40+1+40 = 124. 2-line + tail =
  // 1+1+40+1+40+"\n…and 1 more route"(18) = 101. Budget 120 forces 1-drop.
  const lines = ['A'.repeat(40), 'B'.repeat(40), 'C'.repeat(40)];
  const text = buildRollupPost('H', lines, 120);
  assert.ok(text.endsWith('…and 1 more route'), `got: ${text}`);
  assert.ok(!text.endsWith('routes'));
});

test('sorts events by missing count descending', async () => {
  const getObservations = (route) => {
    if (route === 'A') return buildObs({ pid: 'pa', snapshots: 12, vidsPerSnapshot: 3 }); // missing 3
    if (route === 'B') return buildObs({ pid: 'pb', snapshots: 12, vidsPerSnapshot: 1 }); // missing 5
    return [];
  };
  const events = await detectBusGhosts({
    routes: ['A', 'B'],
    getObservations,
    getPattern: async (pid) => mkPattern('Eastbound', pid === 'pa' ? 'A' : 'B'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].route, 'B');
  assert.equal(events[1].route, 'A');
});
