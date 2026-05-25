const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText } = require('../../src/train/gapPost');

const gap = {
  line: 'brn',
  gapMin: 22,
  expectedMin: 7,
  leading: { destination: 'Kimball', nextStation: 'Belmont' },
  nearStation: { name: 'Belmont' },
};

test('buildPostText renders line, destination, gap duration, station, and schedule', () => {
  const text = buildPostText(gap);
  assert.ok(text.includes('🕳️'));
  assert.ok(text.includes('Brown Line'));
  assert.ok(text.includes('to Kimball'));
  assert.ok(text.includes('No train'));
  assert.ok(text.includes('~22 min'));
  assert.ok(text.includes('Belmont'));
  assert.ok(text.includes('every 7 min'));
});

test('buildPostText falls back to leading.nextStation when nearStation is null', () => {
  const g = { ...gap, nearStation: null };
  const text = buildPostText(g);
  assert.ok(text.includes('Belmont'));
});

test('buildPostText spells out rider roles with Last seen / Next up', () => {
  const g = { ...gap, leading: { ...gap.leading, rn: '711' }, trailing: { rn: '718' } };
  const text = buildPostText(g);
  assert.ok(text.includes('Last seen: #711'));
  assert.ok(text.includes('Next up: #718'));
  assert.ok(!text.includes('Runs:'));
  assert.ok(!text.includes('(last)'));
});

test('buildPostText marks the modeled gap as approximate with a tilde', () => {
  assert.ok(buildPostText(gap).includes('~22 min'));
});

test('buildAltText describes the gap', () => {
  const alt = buildAltText(gap);
  assert.ok(alt.includes('Map of the Brown Line'));
  assert.ok(alt.includes('toward Kimball'));
  assert.ok(alt.includes('22 min gap'));
  assert.ok(alt.includes('Belmont'));
});
