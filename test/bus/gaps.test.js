const test = require('node:test');
const assert = require('node:assert/strict');
const { detectAllGaps, TYPICAL_SPEED_FT_PER_MIN, ABSOLUTE_MIN_MIN } = require('../../src/bus/gaps');
const { bus, FRESH } = require('../helpers');

const pattern = { direction: 'Northbound', lengthFt: 100000 };
const expected = () => 10; // 10-min scheduled headway
const patternFor = () => pattern;

// A gap is flagged when gapMin >= ABSOLUTE_MIN_MIN AND ratio >= 2.5. With a
// 10-min headway, pair distance must exceed max(ABSOLUTE_MIN_MIN, 2.5*10) = 25 min
// of travel time. 25 min × 880 ft/min = 22000 ft.
const MIN_QUALIFYING_FT = Math.ceil(Math.max(ABSOLUTE_MIN_MIN, 2.5 * 10) * TYPICAL_SPEED_FT_PER_MIN);

test('flags a pair beyond threshold with leading/trailing assigned by pdist', () => {
  const a = bus({ vid: '1', pdist: 10000 });
  const b = bus({ vid: '2', pdist: 10000 + MIN_QUALIFYING_FT + 1000 });
  const [gap] = detectAllGaps([a, b], expected, patternFor, FRESH);
  assert.equal(gap.trailing.vid, '1');
  assert.equal(gap.leading.vid, '2');
  assert.ok(gap.ratio >= 2.5);
});

test('skips pairs below the absolute minute minimum', () => {
  // Tight 7-min-headway route: ratio is high even at small gaps, but absolute
  // must clear ABSOLUTE_MIN_MIN.
  const smallGapFt = ABSOLUTE_MIN_MIN * TYPICAL_SPEED_FT_PER_MIN - 1000;
  const vs = [bus({ vid: '1', pdist: 5000 }), bus({ vid: '2', pdist: 5000 + smallGapFt })];
  assert.equal(detectAllGaps(vs, () => 3, patternFor, FRESH).length, 0);
});

test('skips pairs below the ratio threshold on low-frequency routes', () => {
  // 30-min-headway route: even a 40-minute gap is only 1.3x expected.
  const vs = [
    bus({ vid: '1', pdist: 10000 }),
    bus({ vid: '2', pdist: 10000 + 40 * TYPICAL_SPEED_FT_PER_MIN }),
  ];
  assert.equal(detectAllGaps(vs, () => 30, patternFor, FRESH).length, 0);
});

test('skips pairs that straddle the start terminal', () => {
  const vs = [
    bus({ vid: '1', pdist: 100 }), // inside terminal zone
    bus({ vid: '2', pdist: 100 + MIN_QUALIFYING_FT + 1000 }),
  ];
  assert.equal(detectAllGaps(vs, expected, patternFor, FRESH).length, 0);
});

test('skips pairs that end inside the end-terminal zone', () => {
  const vs = [
    bus({ vid: '1', pdist: pattern.lengthFt - MIN_QUALIFYING_FT - 2000 }),
    bus({ vid: '2', pdist: pattern.lengthFt - 500 }),
  ];
  assert.equal(detectAllGaps(vs, expected, patternFor, FRESH).length, 0);
});

test('skips pids with no scheduled headway', () => {
  const vs = [bus({ vid: '1', pdist: 10000 }), bus({ vid: '2', pdist: 40000 })];
  assert.equal(detectAllGaps(vs, () => null, patternFor, FRESH).length, 0);
});

test('sorts multiple gaps worst-first by ratio', () => {
  const vs = [
    // pid 100: 30-min-ish gap on a 10-min headway → ratio ~3
    bus({ vid: '1', pid: '100', pdist: 10000 }),
    bus({ vid: '2', pid: '100', pdist: 10000 + 30 * TYPICAL_SPEED_FT_PER_MIN }),
    // pid 200: 50-min-ish gap on a 10-min headway → ratio ~5
    bus({ vid: '3', pid: '200', pdist: 10000 }),
    bus({ vid: '4', pid: '200', pdist: 10000 + 50 * TYPICAL_SPEED_FT_PER_MIN }),
  ];
  const gaps = detectAllGaps(vs, expected, patternFor, FRESH);
  assert.equal(gaps[0].pid, '200');
  assert.ok(gaps[0].ratio > gaps[1].ratio);
});
