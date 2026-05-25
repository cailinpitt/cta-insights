const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText, SINGLE_DIRECTION_LINES } = require('../../bin/train/speedmap');

const t0 = new Date('2026-05-18T13:00:00Z'); // 8:00 AM CT
const t1 = new Date('2026-05-18T14:00:00Z'); // 9:00 AM CT

test('Yellow is a single-direction line', () => {
  assert.ok(SINGLE_DIRECTION_LINES.has('y'));
});

test('Yellow post text: one combined ribbon, no Unknown direction', () => {
  const dirs = [{ dest: null, summary: { avg: 33.9 }, numBins: 8 }];
  const text = buildPostText('y', dirs, t0, t1, [], true);
  assert.match(text, /Average: 33\.9 mph/);
  assert.match(text, /One ribbon — the CTA feed reports a single direction for the Yellow Line\./);
  assert.doesNotMatch(text, /Unknown direction/);
  assert.doesNotMatch(text, /Two parallel ribbons/);
});

test('Yellow alt text: describes a single combined ribbon', () => {
  const dirs = [{ dest: null, summary: { avg: 33.9 }, numBins: 8 }];
  const alt = buildAltText('y', dirs, 60, true);
  assert.match(alt, /single ribbon/);
  assert.match(alt, /Average 33\.9 mph/);
  assert.doesNotMatch(alt, /two parallel ribbons/);
});

test('Multi-direction lines keep the dual-ribbon layout and direction labels', () => {
  const dirs = [
    { dest: 'Howard', summary: { avg: 22.0 }, numBins: 20 },
    { dest: '95th/Dan Ryan', summary: { avg: 24.5 }, numBins: 20 },
  ];
  const text = buildPostText('red', dirs, t0, t1, [], false);
  assert.match(text, /Toward Howard: 22\.0 mph/);
  assert.match(text, /Toward 95th\/Dan Ryan: 24\.5 mph/);
  assert.match(text, /Two parallel ribbons = the two travel directions\./);
});
