const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText, countByLine } = require('../../src/train/snapshot');
const { train } = require('../helpers');

const NOON_CT = new Date('2026-04-18T17:00:00Z'); // 12:00 PM CT

test('countByLine tallies trains per line', () => {
  const m = countByLine([
    train({ line: 'red' }), train({ line: 'red' }), train({ line: 'blue' }),
  ]);
  assert.equal(m.get('red'), 2);
  assert.equal(m.get('blue'), 1);
  assert.equal(m.get('brn'), undefined);
});

test('buildPostText includes time, total, and all 8 lines with counts', () => {
  const trains = [
    train({ line: 'red' }), train({ line: 'red' }), train({ line: 'g' }),
  ];
  const text = buildPostText(trains, NOON_CT);
  assert.ok(text.includes('3 trains system-wide'));
  assert.ok(text.includes('12:00 PM CT'));
  assert.ok(text.includes('Red 2'));
  assert.ok(text.includes('Green 1'));
  assert.ok(text.includes('Blue 0'));
  assert.ok(text.includes('Yellow 0'));
});

test('buildPostText renders zero trains cleanly', () => {
  const text = buildPostText([], NOON_CT);
  assert.ok(text.includes('0 trains system-wide'));
  assert.ok(text.includes('Red 0'));
});

test('buildAltText summarizes count and per-line breakdown', () => {
  const trains = [train({ line: 'red' }), train({ line: 'pink' })];
  const alt = buildAltText(trains);
  assert.ok(alt.includes('2 CTA L trains'));
  assert.ok(alt.includes('1 Red'));
  assert.ok(alt.includes('1 Pink'));
  assert.ok(alt.includes('0 Blue'));
});
