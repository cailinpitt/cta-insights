const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText, buildGapVideoPostText } = require('../../src/train/gapPost');

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

test('buildPostText names the stretch between flanking stations', () => {
  const g = { ...gap, flankBefore: { name: 'Racine' }, flankAfter: { name: 'Oak Park (Blue)' } };
  const text = buildPostText(g);
  assert.ok(text.includes('No trains between Racine and Oak Park'));
  assert.ok(text.includes('a ~22 min gap'));
  assert.ok(text.includes('every 7 min'));
  // Does not fall back to the single midpoint phrasing when flanks are present.
  assert.ok(!text.includes('near Belmont'));
});

test('buildAltText names the stretch between flanking stations', () => {
  const g = { ...gap, flankBefore: { name: 'Racine' }, flankAfter: { name: 'Oak Park (Blue)' } };
  const alt = buildAltText(g);
  assert.ok(alt.includes('with no trains between Racine and Oak Park'));
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

test('buildGapVideoPostText names the mid-gap stop when the train reaches it', () => {
  const result = { reached: true, gapMin: 22, elapsedSec: 600, startDistFt: 5_000, endDistFt: 0 };
  const text = buildGapVideoPostText(gap, result);
  assert.ok(text.includes('~22 min Brown Line gap'));
  assert.ok(text.includes('reached Belmont — the middle of the gap'));
  assert.ok(text.includes('10 minutes later'));
});

test('buildGapVideoPostText reports the concrete remaining distance in miles', () => {
  const result = {
    reached: false,
    gapMin: 22,
    elapsedSec: 600,
    startDistFt: 10_000,
    endDistFt: 5_000,
  };
  const text = buildGapVideoPostText(gap, result);
  assert.ok(text.includes('closed to within ~0.95 mi of Belmont'));
  assert.ok(text.includes('the middle of the gap'));
});

test('buildGapVideoPostText reports remaining distance in feet under a quarter mile', () => {
  const result = {
    reached: false,
    gapMin: 22,
    elapsedSec: 600,
    startDistFt: 10_000,
    endDistFt: 640,
  };
  const text = buildGapVideoPostText(gap, result);
  assert.ok(text.includes('closed to within ~640 ft of Belmont'));
});

test('buildGapVideoPostText ties in the Next up run number when present', () => {
  const g = { ...gap, trailing: { rn: '110' } };
  const result = { reached: true, gapMin: 22, elapsedSec: 600, startDistFt: 5_000, endDistFt: 0 };
  assert.ok(buildGapVideoPostText(g, result).includes('next train (#110) reached'));
});

test('buildGapVideoPostText falls back to leading.nextStation when nearStation is null', () => {
  const g = { ...gap, nearStation: null };
  const result = { reached: true, gapMin: 22, elapsedSec: 600, startDistFt: 5_000, endDistFt: 0 };
  const text = buildGapVideoPostText(g, result);
  assert.ok(text.includes('Belmont'));
});
