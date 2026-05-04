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
  assert.ok(text.includes('buses bunched together'));
  assert.ok(text.includes('appear stuck in place') || text.includes('service gap forming'));
});

test('describeSignal handles unknown source gracefully', () => {
  const text = describeSignal({ source: 'unknown', severity: 0.5, detail: null }, 'train');
  assert.ok(text.includes('unknown'));
});

test('describeSignal: bunching uses plain-language suppression reason', () => {
  const cd = describeSignal(
    {
      source: 'bunching',
      severity: 0.8,
      detail: JSON.stringify({ vehicles: 4, suppressed: 'cooldown' }),
    },
    'bus',
  );
  assert.ok(cd.includes('4 buses bunched together'));
  assert.ok(cd.includes('covered by a recent post'));
  assert.ok(!cd.toLowerCase().includes('near-miss'));

  const cap = describeSignal(
    {
      source: 'bunching',
      severity: 0.8,
      detail: JSON.stringify({ vehicles: 5, suppressed: 'cap' }),
    },
    'bus',
  );
  assert.ok(cap.includes("over today's post limit"));
});

test('describeSignal: gap ratio rounds to one decimal', () => {
  const text = describeSignal(
    {
      source: 'gap',
      severity: 0.6,
      detail: JSON.stringify({ ratio: 4.073404856013552, suppressed: 'cooldown' }),
    },
    'bus',
  );
  assert.ok(text.includes('4.1x'));
  assert.ok(!text.includes('4.073'));
});

test('describeSignal: ghost missing/expected round to whole vehicles', () => {
  const text = describeSignal(
    { source: 'ghost', severity: 0.7, detail: JSON.stringify({ missing: 7.3, expected: 18.3 }) },
    'bus',
  );
  assert.ok(text.includes('7 of 18 buses missing'));
  assert.ok(!text.includes('.3'));
});

test('describeSignal: bus ghost says "buses" not "trains"', () => {
  const text = describeSignal(
    { source: 'ghost', severity: 0.9, detail: JSON.stringify({ missing: 4, expected: 12 }) },
    'bus',
  );
  assert.ok(text.includes('buses missing'));
});
