const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('node:fs');
const { resolveStopOnRoute, normalizeStopName } = require('../../src/bus/patterns');

// Load cached pattern fixtures directly off disk to keep tests independent of
// loadPattern's 24h TTL — otherwise stale fixtures trigger a live API fetch
// and the test fails with no network.
const PATTERN_DIR = Path.join(__dirname, '..', '..', 'data', 'patterns');
const loadPattern = async (pid) =>
  JSON.parse(Fs.readFileSync(Path.join(PATTERN_DIR, `${pid}.json`), 'utf8'));

test('normalizeStopName lowercases + collapses whitespace', () => {
  assert.equal(normalizeStopName('Archer & Nottingham'), 'archer & nottingham');
  assert.equal(normalizeStopName('  Belmont,  Halsted  '), 'belmont halsted');
});

test('resolveStopOnRoute: exact match resolves on real cached pattern', async () => {
  const hit = await resolveStopOnRoute({
    pids: ['7111'],
    loadPattern,
    stopName: 'Archer & Nottingham',
  });
  assert.ok(hit, 'expected match');
  assert.equal(hit.pid, '7111');
  assert.equal(hit.stopName, 'Archer & Nottingham');
  assert.equal(typeof hit.pdist, 'number');
  assert.ok(hit.pdist > 0);
});

test('resolveStopOnRoute: junction "/" form matches "&" stop name', async () => {
  // Headlines often write "Belmont/Halsted"; cached pattern has "& "
  const hit = await resolveStopOnRoute({
    pids: ['7111'],
    loadPattern,
    stopName: 'Archer/Nottingham',
  });
  assert.ok(hit, 'expected junction-canonicalized match');
  assert.equal(hit.stopName, 'Archer & Nottingham');
});

test('resolveStopOnRoute: unknown stop returns null', async () => {
  const hit = await resolveStopOnRoute({
    pids: ['7111'],
    loadPattern,
    stopName: 'Nonexistent & Foo',
  });
  assert.equal(hit, null);
});

test('resolveStopOnRoute: tries multiple pids and returns first match', async () => {
  const hit = await resolveStopOnRoute({
    pids: ['7120', '7111'],
    loadPattern,
    stopName: 'Archer & Nottingham',
  });
  assert.ok(hit);
  // Whichever pid had the stop should be reported.
  assert.ok(hit.pid === '7111' || hit.pid === '7120');
});

test('resolveStopOnRoute: empty inputs return null', async () => {
  assert.equal(await resolveStopOnRoute({ pids: [], loadPattern, stopName: 'X' }), null);
  assert.equal(await resolveStopOnRoute({ pids: ['7111'], loadPattern, stopName: '' }), null);
});

test('resolveStopOnRoute: works with mock loadPattern (no fs)', async () => {
  const mockPattern = {
    points: [
      { type: 'W', lat: 0, lon: 0 },
      { type: 'S', stopName: 'Belmont & Halsted', pdist: 1234 },
      { type: 'S', stopName: 'Belmont & Sheffield', pdist: 2500 },
    ],
  };
  const mockLoad = async (_pid) => mockPattern;
  const hit = await resolveStopOnRoute({
    pids: ['fakepid'],
    loadPattern: mockLoad,
    stopName: 'Belmont/Halsted',
  });
  assert.deepEqual(hit, { pid: 'fakepid', pdist: 1234, stopName: 'Belmont & Halsted' });
});
