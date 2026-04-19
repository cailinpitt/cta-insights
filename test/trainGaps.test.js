const test = require('node:test');
const assert = require('node:assert/strict');
const { detectAllTrainGaps, TYPICAL_TRAIN_SPEED_FT_PER_MIN, ABSOLUTE_MIN_MIN } = require('../src/train/gaps');
const { train, straightLine, pointAtFt } = require('./helpers');

const LINE_FT = 100000;
const trainLines = { red: [straightLine(LINE_FT)] };

function trainAt(ft, opts = {}) {
  const { lat, lon } = pointAtFt(LINE_FT, ft);
  return train({ lat, lon, ...opts });
}

const stationsByName = () => ({ lat: 42, lon: -87.65 });
const expected10 = () => 10; // scheduled headway

// Qualifying gap: ratio ≥ 2.5 AND gapMin ≥ ABSOLUTE_MIN_MIN. For a 10-min
// headway this means ≥ 25 min travel at 2200 ft/min = 55000 ft.
const QUALIFYING_FT = Math.ceil(Math.max(ABSOLUTE_MIN_MIN, 2.5 * 10) * TYPICAL_TRAIN_SPEED_FT_PER_MIN);

test('flags a pair beyond threshold and orders leading/trailing by trackDist', () => {
  const a = trainAt(10000, { rn: 'A' });
  const b = trainAt(10000 + QUALIFYING_FT + 2000, { rn: 'B' });
  const [gap] = detectAllTrainGaps([a, b], trainLines, [], stationsByName, expected10);
  assert.equal(gap.trailing.rn, 'A');
  assert.equal(gap.leading.rn, 'B');
  assert.ok(gap.ratio >= 2.5);
});

test('skips pairs below the absolute minute minimum on high-freq lines', () => {
  // 3-min headway: ratio can be high at small gaps, but ABSOLUTE_MIN_MIN still applies.
  const smallFt = ABSOLUTE_MIN_MIN * TYPICAL_TRAIN_SPEED_FT_PER_MIN - 2000;
  const trains = [trainAt(10000, { rn: 'A' }), trainAt(10000 + smallFt, { rn: 'B' })];
  assert.equal(detectAllTrainGaps(trains, trainLines, [], stationsByName, () => 3).length, 0);
});

test('skips pairs below the ratio threshold on low-freq lines', () => {
  const trains = [
    trainAt(10000, { rn: 'A' }),
    trainAt(10000 + 25 * TYPICAL_TRAIN_SPEED_FT_PER_MIN, { rn: 'B' }),
  ];
  // 25 min gap on a 20-min line → ratio only 1.25.
  assert.equal(detectAllTrainGaps(trains, trainLines, [], stationsByName, () => 20).length, 0);
});

test('skips pairs inside the terminal zone', () => {
  const trains = [trainAt(500, { rn: 'A' }), trainAt(QUALIFYING_FT + 1500, { rn: 'B' })];
  assert.equal(detectAllTrainGaps(trains, trainLines, [], stationsByName, expected10).length, 0);
});

test('returns no gap when no scheduled headway is available', () => {
  const trains = [trainAt(10000, { rn: 'A' }), trainAt(10000 + QUALIFYING_FT + 2000, { rn: 'B' })];
  assert.equal(detectAllTrainGaps(trains, trainLines, [], stationsByName, () => null).length, 0);
});

test('does not group trains across different trDr', () => {
  const trains = [
    trainAt(10000, { rn: 'A', trDr: '1' }),
    trainAt(10000 + QUALIFYING_FT + 2000, { rn: 'B', trDr: '5' }),
  ];
  assert.equal(detectAllTrainGaps(trains, trainLines, [], stationsByName, expected10).length, 0);
});

test('attaches the station nearest the gap midpoint', () => {
  const stations = [
    { name: 'Far', lat: 42.0, lon: -87.65, lines: ['red'] },
    { name: 'Mid', lat: pointAtFt(LINE_FT, 40000).lat, lon: -87.65, lines: ['red'] },
    { name: 'Other line', lat: pointAtFt(LINE_FT, 40000).lat, lon: -87.65, lines: ['blue'] },
  ];
  const trains = [trainAt(10000, { rn: 'A' }), trainAt(10000 + QUALIFYING_FT + 2000, { rn: 'B' })];
  const [gap] = detectAllTrainGaps(trains, trainLines, stations, stationsByName, expected10);
  assert.equal(gap.nearStation.name, 'Mid');
});

test('sorts gaps worst-first by ratio', () => {
  // Both gaps must fit inside the usable line (terminal zones trimmed).
  const trains = [
    trainAt(15000, { rn: 'A', trDr: '1' }),
    trainAt(15000 + 27 * TYPICAL_TRAIN_SPEED_FT_PER_MIN, { rn: 'B', trDr: '1' }),
    trainAt(15000, { rn: 'C', trDr: '5' }),
    trainAt(15000 + 33 * TYPICAL_TRAIN_SPEED_FT_PER_MIN, { rn: 'D', trDr: '5' }),
  ];
  const gaps = detectAllTrainGaps(trains, trainLines, [], stationsByName, expected10);
  assert.equal(gaps[0].trDr, '5');
  assert.ok(gaps[0].ratio > gaps[1].ratio);
});
