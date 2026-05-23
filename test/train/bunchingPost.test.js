const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../src/train/bunchingPost');

const bunch = {
  line: 'red',
  spanFt: 1200,
  trains: [
    { destination: 'Howard', nextStation: 'Fullerton' },
    { destination: 'Howard', nextStation: 'Fullerton' },
  ],
};

test('buildPostText renders line, destination, count, span, station', () => {
  const text = buildPostText(bunch);
  assert.ok(text.includes('🚆'));
  assert.ok(text.includes('Red Line'));
  assert.ok(text.includes('to Howard'));
  assert.ok(text.includes('2 trains'));
  assert.ok(text.includes('1200 ft') || text.includes('0.23 mi'));
  assert.ok(text.includes('Fullerton'));
});

test('buildAltText describes the map', () => {
  const alt = buildAltText(bunch);
  assert.ok(alt.includes('Red Line'));
  assert.ok(alt.includes('Fullerton'));
  assert.ok(alt.includes('2 trains to Howard'));
});

test('buildVideoPostText reports widening gap', () => {
  const text = buildVideoPostText({ elapsedSec: 300, initialDistFt: 500, finalDistFt: 2000 });
  assert.ok(text.includes('5 minutes later'));
  assert.ok(text.includes('farther apart'));
});

test('buildVideoPostText falls back when final distance is unavailable', () => {
  const text = buildVideoPostText({ elapsedSec: 120 });
  assert.ok(text.includes('Timelapse'));
  assert.ok(text.includes('2 minutes'));
});

test('buildVideoAltText describes timelapse', () => {
  const alt = buildVideoAltText(bunch, { elapsedSec: 300 });
  assert.ok(alt.includes('Timelapse map of the Red Line'));
  assert.ok(alt.includes('5m 0s'));
});

test('buildPostText lists runs with their map number in increasing order', () => {
  const numbered = {
    line: 'red',
    spanFt: 0,
    trains: [
      { rn: '406', destination: 'Howard', nextStation: 'Fullerton' },
      { rn: '413', destination: 'Howard', nextStation: 'Fullerton' },
    ],
  };
  const text = buildPostText(numbered);
  assert.ok(text.includes('Runs: #406 (1), #413 (2)'));
});
