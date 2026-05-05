const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../src/bus/bunchingPost');

const pattern = { direction: 'Northbound' };
const stop = { stopName: 'Michigan & Erie' };
const bunch = { route: '151', vehicles: [{}, {}, {}], spanFt: 889 };

test('buildPostText renders route title, direction, count, span, and stop', () => {
  const text = buildPostText(bunch, pattern, stop);
  assert.ok(text.includes('🚌'));
  assert.ok(text.includes('Route 151'));
  assert.ok(text.includes('Northbound'));
  assert.ok(text.includes('3 buses'));
  assert.ok(text.includes('889 ft'));
  assert.ok(text.includes('Michigan & Erie'));
});

test('buildPostText appends callouts when provided', () => {
  const text = buildPostText(bunch, pattern, stop, ['3rd on this route today']);
  assert.ok(text.includes('3rd on this route today'));
});

test('buildPostText shows 🥇 record line when isAllTimeRecord is true', () => {
  const text = buildPostText(bunch, pattern, stop, [], {
    isAllTimeRecord: true,
    previousRecord: 4,
  });
  assert.ok(text.includes('🥇'));
  assert.ok(text.includes('most buses ever bunched'));
  assert.ok(text.includes('was 4'));
});

test('buildPostText omits record line when isAllTimeRecord is false', () => {
  const text = buildPostText(bunch, pattern, stop, [], {
    isAllTimeRecord: false,
    previousRecord: 9,
  });
  assert.ok(!text.includes('🥇'));
  assert.ok(!text.includes('record'));
});

test('buildAltText describes the map for screen readers', () => {
  const alt = buildAltText(bunch, pattern, stop);
  assert.ok(alt.includes('Map of Route 151'));
  assert.ok(alt.includes('3 northbound buses'));
  assert.ok(alt.includes('Michigan & Erie'));
});

test('buildVideoPostText shows widening gap when buses pulled apart', () => {
  const text = buildVideoPostText({ elapsedSec: 600, initialSpanFt: 500, finalSpanFt: 2500 });
  assert.ok(text.includes('10 minutes later'));
  assert.ok(text.includes('farther apart'));
});

test('buildVideoPostText shows closing gap when buses recovered', () => {
  const text = buildVideoPostText({ elapsedSec: 600, initialSpanFt: 2500, finalSpanFt: 500 });
  assert.ok(text.includes('gap had closed'));
});

test('buildVideoPostText reports "still bunched" on small movement', () => {
  const text = buildVideoPostText({ elapsedSec: 600, initialSpanFt: 900, finalSpanFt: 920 });
  assert.ok(text.includes('Still bunched'));
});

test('buildVideoAltText describes the timelapse', () => {
  const alt = buildVideoAltText(bunch, pattern, stop, { elapsedSec: 600 });
  assert.ok(alt.includes('Timelapse map of Route 151'));
  assert.ok(alt.includes('10m 0s'));
});
