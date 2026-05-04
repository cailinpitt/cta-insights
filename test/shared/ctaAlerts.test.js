const test = require('node:test');
const assert = require('node:assert');
const {
  parseAlerts,
  normalizeAlert,
  extractBetweenStations,
  extractDirection,
  isSignificantAlert,
  cleanText,
} = require('../../src/shared/ctaAlerts');

test('normalizeAlert extracts rail line mapping', () => {
  const raw = {
    AlertId: '12345',
    Headline: 'Red Line: No trains between Belmont and Howard',
    ShortDescription:
      'Trains are not running between Belmont and Howard due to a medical emergency.',
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
  const s = extractBetweenStations(
    'Shuttle buses are running from UIC-Halsted to Forest Park stations.',
  );
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
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Red Line: No trains between Belmont and Howard',
        shortDescription: 'Service suspended due to a police investigation.',
      }),
    ),
    true,
  );
});

test('significant: shuttle buses running', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Blue Line service disruption',
        shortDescription: 'Shuttle buses running between UIC-Halsted and Forest Park.',
      }),
    ),
    true,
  );
});

test('not significant: MajorAlert=0 with no severity, no major keywords', () => {
  assert.equal(
    isSignificantAlert(makeAlert({ major: false, severityScore: 1, headline: 'Service advisory' })),
    false,
  );
});

test('significant: planned shuttle replacement with MajorAlert=0 (Yellow Line scenario)', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 25,
        headline: 'Bus Substitution Between Dempster-Skokie and Howard Stations',
        shortDescription:
          'Shuttle buses replace Yellow Line service between Dempster-Skokie and Howard.',
      }),
    ),
    true,
  );
});

test('not significant: high severity alone (no major flag, no major keyword)', () => {
  // Service-info posts ("Cubs night games", "expanded beach service") routinely
  // score 9-12 without being real disruptions. Severity alone isn't enough.
  assert.equal(
    isSignificantAlert(
      makeAlert({ major: false, severityScore: 11, headline: 'Service advisory' }),
    ),
    false,
  );
});

test('significant: MajorAlert=1 + severity >= MIN_SEVERITY admits', () => {
  assert.equal(
    isSignificantAlert(makeAlert({ major: true, severityScore: 4, headline: 'Service advisory' })),
    true,
  );
});

test('significant: major keyword without major flag (e.g. "suspended")', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 1,
        headline: 'Red Line service suspended between Belmont and Howard',
      }),
    ),
    true,
  );
});

test('extractBetweenStations: capitalized "Between" in headline', () => {
  assert.deepEqual(
    extractBetweenStations('Bus Substitution Between Dempster-Skokie and Howard Stations'),
    { from: 'Dempster-Skokie', to: 'Howard' },
  );
});

test('extractBetweenStations: capitalized "Stations" trailing token', () => {
  assert.deepEqual(
    extractBetweenStations('Service suspended between Belmont and Addison Stations.'),
    { from: 'Belmont', to: 'Addison' },
  );
});

test('extractBetweenStations: prefers disruption-anchored phrase over transfer prose', () => {
  const text =
    'Customers can transfer at Belmont between Brown/Purple and Red trains. ' +
    'Service is suspended between Damen and California due to a switch failure.';
  assert.deepEqual(extractBetweenStations(text), { from: 'Damen', to: 'California' });
});

test('cleanText decodes named and numeric entities', () => {
  assert.equal(
    cleanText('Customers&#39; access &amp; &quot;Loop&quot; service &lt;test&gt;'),
    `Customers' access & "Loop" service <test>`,
  );
});

test('not significant: bus stop temporarily closed', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Route 66: Bus stop at Chicago & State temporarily closed',
      }),
    ),
    false,
  );
});

test('not significant: reroute due to construction', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Route 77 rerouted',
        shortDescription: 'Buses rerouted around construction on Belmont.',
      }),
    ),
    false,
  );
});

test('not significant: elevator outage', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Red Line: Elevator out of service at Belmont',
      }),
    ),
    false,
  );
});

test('not significant: boarding change with same-track running', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Boarding Change, Delays Between LaSalle and Grand',
        shortDescription:
          'Blue Line trains will operate on the same track between LaSalle and Grand, resulting in boarding changes and minor delays.',
      }),
    ),
    false,
  );
});

test('not significant: weekend track work', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Planned weekend service change on the Blue Line',
        shortDescription: 'Track work will affect weekend schedule.',
      }),
    ),
    false,
  );
});

test('minor pattern wins even when major phrasing is present', () => {
  // "No trains" is a major pattern, but "elevator" marks it as a station-level
  // notice — posting would be misleading.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Red Line: No trains stopping at Belmont',
        shortDescription: 'Elevator construction. Use alternate entrance.',
      }),
    ),
    false,
  );
});

test('falls back to MajorAlert=1 + severityScore when no keyword matches', () => {
  // major=true (default in makeAlert), sev=4 → admits via combined signal.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Service advisory',
        shortDescription: 'Expect crowded conditions during the game.',
        severityScore: 4,
      }),
    ),
    true,
  );
  // major=true but sev<MIN_SEVERITY → reject.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        headline: 'Service advisory',
        shortDescription: 'Expect crowded conditions during the game.',
        severityScore: 2,
      }),
    ),
    false,
  );
  // major=false even with high sev → reject without keyword.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        headline: 'Service advisory',
        shortDescription: 'Expect crowded conditions during the game.',
        severityScore: 12,
      }),
    ),
    false,
  );
});

test('not significant: real-world Cubs night-game announcement (sev=11, MajorAlert=0)', () => {
  // Modeled on AlertId 113896 — service info, not a disruption.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 11,
        headline: 'Service for 2026 Cubs Night Games and Wrigley Field Concerts',
        shortDescription:
          'Additional svc from Howard will operate on the Yellow Line for Cubs night games.',
      }),
    ),
    false,
  );
});

test('not significant: real-world expanded beach service (sev=11, MajorAlert=0)', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 11,
        headline: 'CTA Service to the Beaches',
        shortDescription:
          'Service to the lakefront and beaches will be expanded on the #35, #63, #72, and #78 bus routes on weekends and holidays.',
      }),
    ),
    false,
  );
});

test('extractDirection: northbound keyword', () => {
  assert.equal(extractDirection('Northbound trains delayed'), 'north');
});
test('extractDirection: southbound keyword', () => {
  assert.equal(extractDirection('Southbound service halted'), 'south');
});
test('extractDirection: eastbound keyword', () => {
  assert.equal(extractDirection('Eastbound buses rerouted'), 'east');
});
test('extractDirection: westbound keyword', () => {
  assert.equal(extractDirection('Westbound buses rerouted'), 'west');
});
test('extractDirection: inbound keyword', () => {
  assert.equal(extractDirection('Inbound Brown Line trains delayed', 'brn'), 'in');
});
test('extractDirection: outbound keyword', () => {
  assert.equal(extractDirection('Outbound Orange Line', 'org'), 'out');
});
test('extractDirection: toward Howard on red → north', () => {
  assert.equal(
    extractDirection('Trains running with delays toward Howard due to a medical', 'red'),
    'north',
  );
});
test('extractDirection: toward 95th on red → south', () => {
  assert.equal(extractDirection('Trains delayed toward 95th.', 'red'), 'south');
});
test('extractDirection: toward Kimball on brn → out', () => {
  assert.equal(extractDirection('Delays toward Kimball', 'brn'), 'out');
});
test('extractDirection: single-tracking with no compass word → null', () => {
  assert.equal(extractDirection('Single-tracking near Belmont due to signal issue'), null);
  assert.equal(extractDirection('Single track near Wilson'), null);
});
test('extractDirection: no direction word → null', () => {
  assert.equal(extractDirection('Trains delayed near Belmont due to mechanical issue'), null);
});
test('extractDirection: empty/null text → null', () => {
  assert.equal(extractDirection(null), null);
  assert.equal(extractDirection(''), null);
});
