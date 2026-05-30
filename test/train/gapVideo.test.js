const test = require('node:test');
const assert = require('node:assert/strict');
const { gapReadout, ARRIVED_FT } = require('../../src/train/gapVideo');

const G = 16;
const STOP = 'Pulaski';

test('gapReadout counts down the ETA to the named stop while approaching', () => {
  // 11000 ft / 2200 ft-per-min ≈ 5 min.
  assert.equal(gapReadout(G, STOP, 11000), '~16-min gap · next train ~5 min to Pulaski');
});

test('gapReadout shows "reaching" within the arrival window on either side', () => {
  assert.equal(gapReadout(G, STOP, ARRIVED_FT - 100), '~16-min gap · next train reaching Pulaski');
  // Just barely past the stop is still "reaching", not yet "left".
  assert.equal(
    gapReadout(G, STOP, -(ARRIVED_FT - 100)),
    '~16-min gap · next train reaching Pulaski',
  );
});

test('gapReadout says "has left" once the train passes the stop', () => {
  assert.equal(
    gapReadout(G, STOP, -(ARRIVED_FT + 2000)),
    '~16-min gap · next train has left Pulaski',
  );
});

test('gapReadout falls back to unnamed phrasing when no stop name is available', () => {
  assert.equal(gapReadout(G, null, 11000), '~16-min gap · next train ~5 min');
  assert.equal(gapReadout(G, null, 0), '~16-min gap · next train arriving');
  assert.equal(gapReadout(G, null, -(ARRIVED_FT + 2000)), '~16-min gap · next train has left');
});
