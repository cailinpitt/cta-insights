const test = require('node:test');
const assert = require('node:assert/strict');
const { isArticulated } = require('../../src/bus/fleet');

test('isArticulated: returns true for vids inside the 4000-series ranges', () => {
  for (const vid of ['4000', '4067', '4149', '4150', '4207', '4300', '4332', '4333', '4399']) {
    assert.equal(isArticulated(vid), true, `${vid} should be artic`);
  }
});

test('isArticulated: returns false for the 4208-4299 gap', () => {
  for (const vid of ['4208', '4250', '4299']) {
    assert.equal(isArticulated(vid), false, `${vid} should not be artic (gap)`);
  }
});

test('isArticulated: returns false for standard fleet vids', () => {
  for (const vid of ['1000', '1750', '6500', '7900', '8302', '8949']) {
    assert.equal(isArticulated(vid), false, `${vid} should not be artic`);
  }
});

test('isArticulated: returns false for unparseable vids', () => {
  assert.equal(isArticulated(null), false);
  assert.equal(isArticulated(undefined), false);
  assert.equal(isArticulated(''), false);
  assert.equal(isArticulated('abc'), false);
});

test('isArticulated: accepts numeric vids too', () => {
  assert.equal(isArticulated(4067), true);
  assert.equal(isArticulated(8302), false);
});
