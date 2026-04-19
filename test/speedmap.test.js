const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSamples, pickTargetPid, binSamples, summarize } = require('../src/bus/speedmap');

// Build the nested Map<vid, Map<pid, points>> shape the module expects.
function tracks(entries) {
  const out = new Map();
  for (const { vid, pid, points } of entries) {
    if (!out.has(vid)) out.set(vid, new Map());
    out.get(vid).set(pid, points);
  }
  return out;
}

test('computeSamples turns pdist deltas into mph', () => {
  // 880 ft in 60s = 10 mph (since 880 ft/min = 10 mph).
  const { byPid } = computeSamples(tracks([
    { vid: '1', pid: 'A', points: [
      { t: 0, pdist: 0 }, { t: 60_000, pdist: 880 },
    ]},
  ]));
  const samples = byPid.get('A');
  assert.equal(samples.length, 1);
  assert.ok(Math.abs(samples[0].mph - 10) < 0.01);
  assert.equal(samples[0].pdist, 440); // midpoint
});

test('computeSamples skips pattern restarts (pdist decrease)', () => {
  const { byPid, stats } = computeSamples(tracks([
    { vid: '1', pid: 'A', points: [
      { t: 0, pdist: 50000 }, { t: 60_000, pdist: 100 }, // restart
      { t: 120_000, pdist: 1000 }, // valid pair with previous
    ]},
  ]));
  assert.equal(stats.restarts, 1);
  assert.equal(byPid.get('A').length, 1); // only the second pair survives
});

test('computeSamples drops pairs beyond maxDtMs', () => {
  const { byPid, stats } = computeSamples(tracks([
    { vid: '1', pid: 'A', points: [
      { t: 0, pdist: 0 }, { t: 10 * 60_000, pdist: 500 },
    ]},
  ]));
  assert.equal(stats.dropped, 1);
  assert.equal(byPid.get('A'), undefined);
});

test('computeSamples drops out-of-range speeds', () => {
  // 5280 ft in 60s = 60 mph — right at the cap, which is inclusive-upper on
  // the drop check. A higher value should be dropped.
  const { byPid, stats } = computeSamples(tracks([
    { vid: '1', pid: 'A', points: [
      { t: 0, pdist: 0 }, { t: 60_000, pdist: 10000 }, // ~113 mph — absurd
    ]},
  ]));
  assert.equal(stats.dropped, 1);
  assert.equal(byPid.get('A'), undefined);
});

test('pickTargetPid picks the pid with the most samples', () => {
  const byPid = new Map([
    ['A', [{}, {}]],
    ['B', [{}, {}, {}, {}]],
    ['C', [{}]],
  ]);
  assert.equal(pickTargetPid(byPid), 'B');
});

test('binSamples averages per bucket, null for empty buckets', () => {
  const samples = [
    { pdist: 10, mph: 10 },
    { pdist: 15, mph: 20 },
    { pdist: 75, mph: 30 }, // bucket 3
  ];
  const bins = binSamples(samples, 100, 4); // buckets of 25 ft
  assert.equal(bins[0], 15);    // avg of 10, 20
  assert.equal(bins[1], null);
  assert.equal(bins[2], null);
  assert.equal(bins[3], 30);
});

test('summarize counts bins by color band and computes avg', () => {
  const { avg, red, orange, yellow, green } = summarize([null, 3, 7, 12, 20]);
  assert.equal(red, 1);     // 3
  assert.equal(orange, 1);  // 7 (5 ≤ s < 10)
  assert.equal(yellow, 1);  // 12
  assert.equal(green, 1);   // 20
  assert.equal(avg, (3 + 7 + 12 + 20) / 4);
});

test('summarize returns zeros + null avg when no valid speeds', () => {
  assert.deepEqual(summarize([null, null]), { avg: null, red: 0, orange: 0, yellow: 0, green: 0 });
});
