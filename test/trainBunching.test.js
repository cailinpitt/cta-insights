const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTrainBunching, TRAIN_BUNCHING_FT, MIN_DISTANCE_FT } = require('../src/train/bunching');
const { train, straightLine, pointAtFt } = require('./helpers');

const LINE_FT = 50000;
const trainLines = { red: [straightLine(LINE_FT)] };

function trainAt(ft, opts = {}) {
  const { lat, lon } = pointAtFt(LINE_FT, ft);
  return train({ lat, lon, ...opts });
}

test('detects two trains within the threshold', () => {
  const bunch = detectTrainBunching([
    trainAt(20000, { rn: '1' }),
    trainAt(21000, { rn: '2' }),
  ], trainLines);
  assert.equal(bunch.trains.length, 2);
  assert.ok(bunch.spanFt >= 900 && bunch.spanFt <= 1100);
});

test('extends to a 3-train cluster with maxGap tracking', () => {
  const bunch = detectTrainBunching([
    trainAt(20000, { rn: '1' }),
    trainAt(21500, { rn: '2' }),
    trainAt(23000, { rn: '3' }),
  ], trainLines);
  assert.equal(bunch.trains.length, 3);
  assert.ok(bunch.maxGapFt >= 1400 && bunch.maxGapFt <= 1600);
});

test('rejects pairs beyond TRAIN_BUNCHING_FT', () => {
  const bunch = detectTrainBunching([
    trainAt(20000),
    trainAt(20000 + TRAIN_BUNCHING_FT + 500, { rn: '2' }),
  ], trainLines);
  assert.equal(bunch, null);
});

test('dedupes near-coincident snaps (within MIN_DISTANCE_FT)', () => {
  // Two trains essentially on top of each other + a third far enough for a real bunch.
  const bunch = detectTrainBunching([
    trainAt(20000, { rn: '1' }),
    trainAt(20000 + MIN_DISTANCE_FT - 50, { rn: '2' }),
    trainAt(21500, { rn: '3' }),
  ], trainLines);
  // Duplicate is dropped; the real bunch is between the first kept train and #3.
  assert.equal(bunch.trains.length, 2);
  assert.equal(bunch.trains[0].rn, '1');
  assert.equal(bunch.trains[1].rn, '3');
});

test('skips bunches inside the start-terminal zone', () => {
  const bunch = detectTrainBunching([
    trainAt(500, { rn: '1' }),
    trainAt(1200, { rn: '2' }),
  ], trainLines);
  assert.equal(bunch, null);
});

test('skips bunches inside the end-terminal zone', () => {
  const bunch = detectTrainBunching([
    trainAt(LINE_FT - 1200, { rn: '1' }),
    trainAt(LINE_FT - 500, { rn: '2' }),
  ], trainLines);
  assert.equal(bunch, null);
});

test('heading gate rejects trains moving opposite directions', () => {
  const bunch = detectTrainBunching([
    trainAt(20000, { rn: '1', heading: 0 }),
    trainAt(21000, { rn: '2', heading: 180 }),
  ], trainLines);
  assert.equal(bunch, null);
});

test('does not merge trains on different trDr', () => {
  const bunch = detectTrainBunching([
    trainAt(20000, { rn: '1', trDr: '1' }),
    trainAt(21000, { rn: '2', trDr: '5' }),
  ], trainLines);
  assert.equal(bunch, null);
});

test('ranks size desc then tighter max gap', () => {
  // Single 3-cluster on red beats a tighter 2-cluster by size.
  const bunch = detectTrainBunching([
    trainAt(20000, { rn: '1' }),
    trainAt(21500, { rn: '2' }),
    trainAt(23000, { rn: '3' }),
    trainAt(30000, { rn: '4' }),
    trainAt(30200, { rn: '5' }),
  ], trainLines);
  assert.equal(bunch.trains.length, 3);
});
