const test = require('node:test');
const assert = require('node:assert');
const { isStationOnSegment, normalizeStationName } = require('../../src/shared/trainSegment');

test('normalizeStationName strips parentheticals + collapses whitespace', () => {
  assert.equal(normalizeStationName('Halsted (Orange)'), 'halsted');
  assert.equal(normalizeStationName('  UIC-Halsted  '), 'uic-halsted');
  assert.equal(normalizeStationName('Western (Blue - Forest Park Branch)'), 'western');
});

test('Wilson is between Belmont and Howard on red NB', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      direction: 'north',
      station: 'Wilson',
      fromStation: 'Belmont',
      toStation: 'Howard',
    }),
    true,
  );
});

test('Addison is between Belmont and Howard on red (no direction)', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      station: 'Addison',
      fromStation: 'Belmont',
      toStation: 'Howard',
    }),
    true,
  );
});

test('95th/Dan Ryan is NOT between Belmont and Howard on red', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      direction: 'north',
      station: '95th/Dan Ryan',
      fromStation: 'Belmont',
      toStation: 'Howard',
    }),
    false,
  );
});

test('round-trip line: out-of-segment station fails', () => {
  // Brown round-trips. Belmont is 25k+ ft past the Kimball→Western segment
  // (which ends at ~7300 ft); even with the per-stop buffer it's well outside.
  assert.equal(
    isStationOnSegment({
      line: 'brn',
      direction: 'out',
      station: 'Belmont',
      fromStation: 'Kimball',
      toStation: 'Western (Brown)',
    }),
    false,
  );
});

test('round-trip line: in-segment station succeeds with matching direction', () => {
  // Brown line: Western is between Kimball and Belmont in outbound direction.
  assert.equal(
    isStationOnSegment({
      line: 'brn',
      direction: 'out',
      station: 'Western (Brown)',
      fromStation: 'Kimball',
      toStation: 'Belmont',
    }),
    true,
  );
});

test('unknown station name returns false (fail closed)', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      station: 'Nonexistent Station',
      fromStation: 'Belmont',
      toStation: 'Howard',
    }),
    false,
  );
});

test('missing args return false', () => {
  assert.equal(isStationOnSegment({ line: 'red', station: 'Wilson' }), false);
  assert.equal(isStationOnSegment({}), false);
});

test('parenthetical line tag in name still resolves', () => {
  assert.equal(
    isStationOnSegment({
      line: 'red',
      station: 'Wilson',
      fromStation: 'Belmont (Red)',
      toStation: 'Howard',
    }),
    true,
  );
});
