const test = require('node:test');
const assert = require('node:assert/strict');
const { detectBusGhosts, MIN_SNAPSHOTS } = require('../src/bus/ghosts');
const { buildRollupPost } = require('../src/shared/post');
const { detectTrainGhosts } = require('../src/train/ghosts');

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
  assert.equal(text, 'head\n\na\nb\nc');
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

// Synthetic train observations: N snapshots, with a configurable number of
// distinct vehicles on each of two Train Tracker directions (trDr=1, trDr=5).
function buildTrainObs({ snapshots, vidsTrDr1, vidsTrDr5, destination = 'Loop', startTs = 1_700_000_000_000, intervalMs = 5 * 60 * 1000 }) {
  const rows = [];
  for (let i = 0; i < snapshots; i++) {
    const ts = startTs + i * intervalMs;
    for (let v = 0; v < vidsTrDr1; v++) rows.push({ ts, direction: '1', vehicle_id: `a${v}`, destination });
    for (let v = 0; v < vidsTrDr5; v++) rows.push({ ts, direction: '5', vehicle_id: `b${v}`, destination: '54th/Cermak' });
  }
  return rows;
}

test('loop lines aggregate across trDrs instead of splitting', async () => {
  // Expected line-wide: 62 / 10 = 6.2 trains active on the entire Pink Line.
  // Observed: 2 trDr=1 + 1 trDr=5 = 3 distinct vehicles per snapshot.
  // Missing: 3.2 — passes the 3.0 abs threshold and >50% pct threshold.
  // Without the loop-aware path, grouping by trDr would compare 2 vs 6.2 and 1
  // vs 6.2 separately, wildly overstating missing.
  const obs = buildTrainObs({ snapshots: 12, vidsTrDr1: 2, vidsTrDr5: 1 });
  const events = await detectTrainGhosts({
    lines: ['pink'],
    getObservations: () => obs,
    findStation: () => null,
    expectedHeadway: () => 10,
    expectedDuration: () => 62,
    isLoopLine: () => true,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].line, 'pink');
  assert.equal(events[0].trDr, null);
  assert.equal(events[0].destination, null);
  assert.equal(events[0].observedActive, 3);
  assert.ok(Math.abs(events[0].expectedActive - 6.2) < 1e-9);
});

test('loop lines suppress false positives that per-trDr grouping would fire', async () => {
  // Pink Loop at healthy service: ~6 trains line-wide, split 3 trDr=1 + 3 trDr=5.
  // Line-wide observed=6 matches expected=6.2 — no ghost.
  // Under the old per-trDr logic, this would fire two ghost events (3 vs 6.2 each).
  const obs = buildTrainObs({ snapshots: 12, vidsTrDr1: 3, vidsTrDr5: 3 });
  const events = await detectTrainGhosts({
    lines: ['pink'],
    getObservations: () => obs,
    findStation: () => null,
    expectedHeadway: () => 10,
    expectedDuration: () => 62,
    isLoopLine: () => true,
  });
  assert.equal(events.length, 0);
});

test('bi-directional lines still split by trDr', async () => {
  // Blue Line Forest Park: expected 14, observed 9 → missing 5 on just the
  // trDr=5 side. isLoopLine returns false, so the existing per-trDr grouping
  // runs and fires a ghost for one direction while the other passes.
  const obs = buildTrainObs({ snapshots: 12, vidsTrDr1: 14, vidsTrDr5: 9, destination: 'Forest Park' });
  const events = await detectTrainGhosts({
    lines: ['blue'],
    getObservations: () => obs,
    findStation: () => ({ lat: 41.87, lon: -87.81, isTerminal: true }),
    expectedHeadway: () => 6,
    expectedDuration: () => 84,
    isLoopLine: () => false,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].trDr, '5');
  assert.equal(events[0].observedActive, 9);
  assert.equal(events[0].expectedActive, 14);
});

test('bi-directional line: skips direction whose destinations are all short-turns', async () => {
  const obs = buildTrainObs({ snapshots: 12, vidsTrDr1: 14, vidsTrDr5: 9, destination: 'UIC-Halsted' });
  const events = await detectTrainGhosts({
    lines: ['blue'],
    getObservations: () => obs,
    findStation: () => ({ lat: 41.87, lon: -87.65, isTerminal: false }),
    expectedHeadway: () => 6,
    expectedDuration: () => 84,
    isLoopLine: () => false,
  });
  assert.equal(events.length, 0);
});

test('bi-directional line: prefers a terminal destination when mixed with short-turns', async () => {
  const obs = buildTrainObs({ snapshots: 12, vidsTrDr1: 14, vidsTrDr5: 9, destination: null });
  // Half the observations say UIC-Halsted (short-turn), half Forest Park (terminal).
  for (let i = 0; i < obs.length; i++) {
    obs[i].destination = i % 2 === 0 ? 'UIC-Halsted' : 'Forest Park';
  }
  const findStation = (line, dest) => {
    if (dest === 'Forest Park') return { lat: 41.87, lon: -87.81, isTerminal: true };
    return { lat: 41.87, lon: -87.65, isTerminal: false };
  };
  const events = await detectTrainGhosts({
    lines: ['blue'],
    getObservations: () => obs,
    findStation,
    expectedHeadway: () => 6,
    expectedDuration: () => 84,
    isLoopLine: () => false,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].destination, 'Forest Park');
});

test('skips a route entirely when any observed pid fails pattern resolution', async () => {
  const obs = [
    ...buildObs({ pid: 'good', snapshots: 12, vidsPerSnapshot: 3 }),
    ...buildObs({ pid: 'broken', snapshots: 12, vidsPerSnapshot: 3 }).map((r, i) => ({ ...r, vehicle_id: `x${i % 3}` })),
  ];
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async (pid) => {
      if (pid === 'broken') throw new Error('CTA getpatterns down');
      return mkPattern('Eastbound');
    },
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('skips a route when a pid resolves to a pattern with no direction label', async () => {
  const obs = buildObs({ pid: 'headless', snapshots: 12, vidsPerSnapshot: 3 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => ({ pid: 'headless', direction: '', route: '66' }),
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('bus formatLine: ratio > 3 drops effective-headway estimate and says "scheduled every"', () => {
  const { formatLine } = require('../bin/bus/ghosts');
  const out = formatLine({ route: '22', direction: 'Northbound', missing: 9, expectedActive: 10, observedActive: 1, headway: 10 });
  assert.match(out, /scheduled every ~10 min$/);
  assert.doesNotMatch(out, /instead of/);
});

test('bus formatLine: ratio <= 3 keeps effective-headway estimate', () => {
  const { formatLine } = require('../bin/bus/ghosts');
  const out = formatLine({ route: '22', direction: 'Northbound', missing: 4, expectedActive: 10, observedActive: 6, headway: 10 });
  assert.match(out, /every ~17 min instead of ~10$/);
});

test('train formatLine: ratio > 3 drops effective-headway estimate', () => {
  const { formatLine } = require('../bin/train/ghosts');
  const out = formatLine({ line: 'red', destination: 'Howard', missing: 10, expectedActive: 12, observedActive: 1, headway: 8 });
  assert.match(out, /scheduled every ~8 min$/);
  assert.doesNotMatch(out, /instead of/);
});

test('train formatLine: ratio <= 3 keeps effective-headway estimate', () => {
  const { formatLine } = require('../bin/train/ghosts');
  const out = formatLine({ line: 'red', destination: 'Howard', missing: 4, expectedActive: 12, observedActive: 8, headway: 8 });
  assert.match(out, /every ~12 min instead of ~8$/);
});

test('sanity gate: MIN_OBSERVED blocks events when observed drops below 2', async () => {
  // Headway 6, duration 60 → expected 10. Observed 1 → missing 9, pct 90%,
  // passes the main thresholds but fails the observed-floor sanity gate.
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 1 });
  const events = await detectBusGhosts({
    routes: ['66'], getObservations: () => obs, getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 6, expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('sanity gate: MIN_SNAPSHOTS=8 blocks coverage below 8 snapshots', async () => {
  const obs = buildObs({ pid: 'p1', snapshots: 7, vidsPerSnapshot: 3 });
  const events = await detectBusGhosts({
    routes: ['66'], getObservations: () => obs, getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 6, expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('sanity gate: MAX_EXPECTED_ACTIVE cap blocks absurd schedules', async () => {
  // Headway 0.5, duration 60 → expected 120. Well above the 30 cap.
  const obs = buildObs({ pid: 'p1', snapshots: 12, vidsPerSnapshot: 10 });
  const events = await detectBusGhosts({
    routes: ['66'], getObservations: () => obs, getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 0.5, expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('sanity gate: stddev > observed blocks noisy/bimodal polling windows', async () => {
  const obs = [];
  const ts0 = 1_700_000_000_000;
  const pattern = [0, 2, 0, 8, 0, 2, 0, 8, 0, 2, 0, 8];
  for (let i = 0; i < pattern.length; i++) {
    const ts = ts0 + i * 5 * 60 * 1000;
    for (let v = 0; v < pattern[i]; v++) {
      obs.push({ ts, direction: 'pid1', vehicle_id: `t${i}v${v}`, route: '66' });
    }
  }
  const events = await detectBusGhosts({
    routes: ['66'], getObservations: () => obs, getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 6, expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('sorts events by missing count descending', async () => {
  const getObservations = (route) => {
    if (route === 'A') return buildObs({ pid: 'pa', snapshots: 12, vidsPerSnapshot: 3 }); // missing 3
    if (route === 'B') return buildObs({ pid: 'pb', snapshots: 12, vidsPerSnapshot: 2 }); // missing 4
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
