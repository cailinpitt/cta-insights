const test = require('node:test');
const assert = require('node:assert');
const { scoreSignals, buildRoundupText, describeSignal } = require('../../bin/incident-roundup');

test('scoreSignals dedupes by source, takes max severity', () => {
  const signals = [
    { source: 'gap', severity: 0.5, detail: null },
    { source: 'gap', severity: 0.8, detail: null },
    { source: 'pulse-cold', severity: 0.5, detail: null },
  ];
  const { total, bySource } = scoreSignals(signals);
  assert.equal(bySource.get('gap'), 0.8);
  assert.equal(bySource.get('pulse-cold'), 0.5);
  assert.equal(Math.round(total * 10) / 10, 1.3);
});

test('train roundup text includes line name and signals', () => {
  const text = buildRoundupText({
    kind: 'train',
    line: 'red',
    signals: [
      { source: 'gap', severity: 0.7, detail: JSON.stringify({ ratio: 2.6, suppressed: 'cap' }) },
      { source: 'ghost', severity: 0.9, detail: JSON.stringify({ missing: 2.5, expected: 8.5 }) },
    ],
  });
  assert.ok(text.includes('Red'));
  assert.ok(text.includes('multiple service signals'));
  assert.ok(text.includes('2.6x'));
  assert.ok(text.includes('trains missing'));
});

test('bus roundup text uses #route framing and "buses missing"', () => {
  const text = buildRoundupText({
    kind: 'bus',
    line: '147',
    name: 'Outer DuSable Lake Shore Express',
    signals: [
      { source: 'gap', severity: 0.7, detail: JSON.stringify({ ratio: 4.0, suppressed: 'cap' }) },
      {
        source: 'bunching',
        severity: 0.6,
        detail: JSON.stringify({ vehicles: 3, span_ft: 1040, suppressed: 'cap' }),
      },
      {
        source: 'pulse-held',
        severity: 1.0,
        detail: JSON.stringify({ route: '147', kind: 'held' }),
      },
    ],
  });
  assert.ok(text.includes('#147'));
  assert.ok(text.includes('Outer DuSable'));
  assert.ok(text.includes('bunching near-miss'));
  assert.ok(text.includes('pulse near-miss'));
});

test('describeSignal handles unknown source gracefully', () => {
  const text = describeSignal({ source: 'unknown', severity: 0.5, detail: null }, 'train');
  assert.ok(text.includes('unknown'));
});

test('describeSignal: bus ghost says "buses" not "trains"', () => {
  const text = describeSignal(
    { source: 'ghost', severity: 0.9, detail: JSON.stringify({ missing: 4, expected: 12 }) },
    'bus',
  );
  assert.ok(text.includes('buses missing'));
});
