const test = require('node:test');
const assert = require('node:assert/strict');
const { findStationByDestination } = require('../../src/train/findStation');

const STATIONS = [
  { name: 'Howard', lines: ['red', 'p', 'y'], isTerminal: true },
  { name: '95th/Dan Ryan', lines: ['red'], isTerminal: true },
  { name: 'Forest Park', lines: ['blue'], isTerminal: true },
  { name: "O'Hare", lines: ['blue'], isTerminal: true },
  { name: 'UIC-Halsted', lines: ['blue'] },
  { name: 'Harlem (Blue - O\'Hare Branch)', lines: ['blue'] },
  { name: '54th/Cermak', lines: ['pink'], isTerminal: true },
  { name: 'Halsted', lines: ['g', 'org'] },
];

test('exact verbatim match returns the station', () => {
  const s = findStationByDestination('red', 'Howard', STATIONS);
  assert.equal(s?.name, 'Howard');
});

test('alias resolves 95th → 95th/Dan Ryan', () => {
  const s = findStationByDestination('red', '95th', STATIONS);
  assert.equal(s?.name, '95th/Dan Ryan');
});

test('alias case-insensitive: 95TH/DAN RYAN resolves', () => {
  const s = findStationByDestination('red', '95TH/DAN RYAN', STATIONS);
  assert.equal(s?.name, '95th/Dan Ryan');
});

test('base-name match strips parenthetical suffix', () => {
  const s = findStationByDestination('blue', 'Harlem', STATIONS);
  assert.equal(s?.name, "Harlem (Blue - O'Hare Branch)");
});

test('Loop alias returns null (deliberately unresolvable)', () => {
  const s = findStationByDestination('brn', 'Loop', STATIONS);
  assert.equal(s, null);
});

test('See Train alias returns null', () => {
  const s = findStationByDestination('red', 'See Train', STATIONS);
  assert.equal(s, null);
});

test('unmatched destination returns null (no cross-line prefix leak)', () => {
  const s = findStationByDestination('red', 'Random Unknown Place', STATIONS);
  assert.equal(s, null);
});

test('line filter: Halsted on blue does not return the orange Halsted', () => {
  const s = findStationByDestination('blue', 'Halsted', STATIONS);
  assert.equal(s, null);
});

test('null/empty destination returns null', () => {
  assert.equal(findStationByDestination('red', null, STATIONS), null);
  assert.equal(findStationByDestination('red', '', STATIONS), null);
});

test('regression: Harlem no longer loose-matches Harlem/Lake via includes', () => {
  const stations = [
    { name: 'Harlem/Lake', lines: ['g'], isTerminal: true },
    { name: 'Harlem (Blue - Forest Park Branch)', lines: ['blue'] },
  ];
  // "Harlem" on green should NOT resolve to Harlem/Lake via the removed
  // includes-tier; base-name of "Harlem/Lake" is "Harlem/Lake", not "Harlem".
  const s = findStationByDestination('g', 'Harlem', stations);
  assert.equal(s, null);
});
