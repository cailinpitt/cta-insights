const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText } = require('../../src/bus/gapPost');

const pattern = { direction: 'Southbound' };
const stop = { stopName: 'Foster & Marine Drive' };
const gap = { route: '147', gapMin: 35, expectedMin: 9 };

test('buildPostText includes gap duration, stop, and scheduled headway', () => {
  const text = buildPostText(gap, pattern, stop);
  assert.ok(text.includes('🕳️'));
  assert.ok(text.includes('Route 147'));
  assert.ok(text.includes('Southbound'));
  assert.ok(text.includes('No bus'));
  assert.ok(text.includes('~35 min'));
  assert.ok(text.includes('Foster & Marine Drive'));
  assert.ok(text.includes('every 9 min'));
});

test('buildPostText spells out rider roles with Last seen / Next up', () => {
  const g = { ...gap, leading: { vid: '1934' }, trailing: { vid: '8021' } };
  const text = buildPostText(g, pattern, stop);
  assert.ok(text.includes('Last seen: #1934'));
  assert.ok(text.includes('Next up: #8021'));
  assert.ok(!text.includes('Buses:'));
});

test('buildPostText marks the modeled gap as approximate with a tilde', () => {
  assert.ok(buildPostText(gap, pattern, stop).includes('~35 min'));
});

test('buildAltText describes the gap for screen readers', () => {
  const alt = buildAltText(gap, pattern, stop);
  assert.ok(alt.includes('Route 147'));
  assert.ok(alt.includes('southbound'));
  assert.ok(alt.includes('35 min gap'));
  assert.ok(alt.includes('Foster & Marine Drive'));
});
