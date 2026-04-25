const test = require('node:test');
const assert = require('node:assert');
const { parseAlerts, normalizeAlert, extractBetweenStations, isSignificantAlert } = require('../../src/shared/ctaAlerts');

test('normalizeAlert extracts rail line mapping', () => {
  const raw = {
    AlertId: '12345',
    Headline: 'Red Line: No trains between Belmont and Howard',
    ShortDescription: 'Trains are not running between Belmont and Howard due to a medical emergency.',
    MajorAlert: '1',
    SeverityScore: '4',
    ImpactedService: {
      Service: { ServiceType: 'R', ServiceId: 'Red' },
    },
  };
  const a = normalizeAlert(raw);
  assert.equal(a.id, '12345');
  assert.deepEqual(a.trainLines, ['red']);
  assert.equal(a.busRoutes.length, 0);
  assert.equal(a.major, true);
  assert.equal(a.severityScore, 4);
});

test('normalizeAlert handles multi-service impact', () => {
  const raw = {
    AlertId: '99',
    Headline: 'Multi-mode disruption',
    MajorAlert: '1',
    ImpactedService: {
      Service: [
        { ServiceType: 'R', ServiceId: 'Blue' },
        { ServiceType: 'B', ServiceId: '66' },
        { ServiceType: 'B', ServiceId: '77' },
      ],
    },
  };
  const a = normalizeAlert(raw);
  assert.deepEqual(a.trainLines, ['blue']);
  assert.deepEqual(a.busRoutes, ['66', '77']);
});

test('parseAlerts normalizes zero/one/many envelope shapes', () => {
  assert.deepEqual(parseAlerts({ CTAAlerts: {} }), []);
  const oneAlert = parseAlerts({
    CTAAlerts: {
      Alert: {
        AlertId: 'x',
        Headline: 'h',
        MajorAlert: '0',
      },
    },
  });
  assert.equal(oneAlert.length, 1);
  assert.equal(oneAlert[0].id, 'x');
});

test('extractBetweenStations pulls simple "between X and Y"', () => {
  const s = extractBetweenStations('No trains between Belmont and Howard due to an incident.');
  assert.deepEqual(s, { from: 'Belmont', to: 'Howard' });
});

test('extractBetweenStations pulls "from X to Y" phrasing', () => {
  const s = extractBetweenStations('Shuttle buses are running from UIC-Halsted to Forest Park stations.');
  assert.deepEqual(s, { from: 'UIC-Halsted', to: 'Forest Park' });
});

test('extractBetweenStations returns null when no match', () => {
  assert.equal(extractBetweenStations('Elevator out of service at the station.'), null);
});

// --- isSignificantAlert ---

function makeAlert(overrides = {}) {
  return {
    major: true,
    severityScore: 3,
    headline: '',
    shortDescription: '',
    fullDescription: '',
    ...overrides,
  };
}

test('significant: suspended service between two stations', () => {
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Red Line: No trains between Belmont and Howard',
    shortDescription: 'Service suspended due to a police investigation.',
  })), true);
});

test('significant: shuttle buses running', () => {
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Blue Line service disruption',
    shortDescription: 'Shuttle buses running between UIC-Halsted and Forest Park.',
  })), true);
});

test('not significant: MajorAlert=0 baseline', () => {
  assert.equal(isSignificantAlert(makeAlert({ major: false, headline: 'No trains between X and Y' })), false);
});

test('not significant: bus stop temporarily closed', () => {
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Route 66: Bus stop at Chicago & State temporarily closed',
  })), false);
});

test('not significant: reroute due to construction', () => {
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Route 77 rerouted',
    shortDescription: 'Buses rerouted around construction on Belmont.',
  })), false);
});

test('not significant: elevator outage', () => {
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Red Line: Elevator out of service at Belmont',
  })), false);
});

test('not significant: weekend track work', () => {
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Planned weekend service change on the Blue Line',
    shortDescription: 'Track work will affect weekend schedule.',
  })), false);
});

test('minor pattern wins even when major phrasing is present', () => {
  // "No trains" is a major pattern, but "elevator" marks it as a station-level
  // notice — posting would be misleading.
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Red Line: No trains stopping at Belmont',
    shortDescription: 'Elevator construction. Use alternate entrance.',
  })), false);
});

test('falls back to severityScore when no keyword matches', () => {
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Service advisory',
    shortDescription: 'Expect crowded conditions during the game.',
    severityScore: 4,
  })), true);
  assert.equal(isSignificantAlert(makeAlert({
    headline: 'Service advisory',
    shortDescription: 'Expect crowded conditions during the game.',
    severityScore: 2,
  })), false);
});
