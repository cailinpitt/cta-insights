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

test('significant: Impact="Significant Delays" admits even when headline/major/css disagree', () => {
  // Real-world regression — AlertId 114905 (2026-05-13 Red Line police
  // hold at Sox-35th). CTA tagged Impact="Significant Delays" + sev=60
  // but simultaneously MajorAlert=0 and severityCss="minor", with a
  // headline that only said "Service Delayed" (no MAJOR_PATTERN hit).
  // Every other admit path missed it; the Impact admit catches it.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 60,
        severityCss: 'minor',
        impact: 'Significant Delays',
        headline: 'Red Line Service Delayed at Sox-35th',
        shortDescription:
          'Red Line trains are standing at Sox-35th due to police activity. Crews working to restore service.',
      }),
    ),
    true,
  );
});

test('significant: Impact="Major Delays" admits', () => {
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 50,
        impact: 'Major Delays',
        headline: 'Blue Line Service Delayed near Forest Park',
      }),
    ),
    true,
  );
});

test('not significant: Impact="Minor Delays" does NOT auto-admit', () => {
  // The Impact admit list is intentionally narrow — only the
  // explicitly-significant buckets, not every delay variant.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 40,
        impact: 'Minor Delays',
        headline: 'Brown Line Delays',
      }),
    ),
    false,
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

test('significant: multi-route reroute (CPD funeral, 3 routes) admits despite "reroute" wording', () => {
  // Real alert from 2026-05-08: Devon/Foster CPD Funeral Service.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 37, // CTA's default for reroutes
        headline: 'Temporary Reroute',
        shortDescription:
          '#136, #147 and #151 buses are rerouted between Devon/Sheridan-Broadway and Foster/Sheridan due to a CPD Funeral Service.',
        busRoutes: ['136', '147', '151'],
      }),
    ),
    true,
  );
});

test('significant: massive multi-route reroute (12 routes) admits', () => {
  // Real alert from 2026-05-08: SB Michigan/Ida B. Wells closure, 2-day window.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 37,
        headline: 'Temporary Reroute',
        shortDescription:
          'SB buses via Michigan, Ida B. Wells, State, Balbo; 1, 3, 4, X4 resume rte on Michigan; 7, 126, 143, 147 end at Congress Plz; J14, 26, 28 continue on Balbo.',
        busRoutes: ['1', '3', '4', '7', 'J14', '26', '28', '126', '143', '146', '147', 'X4'],
        eventStart: Date.parse('2026-05-08T14:00:00Z'),
        eventEnd: Date.parse('2026-05-10T22:00:00Z'),
      }),
    ),
    true,
  );
});

test('not significant: long-duration multi-route reroute (6-week SB State construction)', () => {
  // Real alert 114213 from 2026-05-10: Apr 13 → May 25 SB State construction
  // touching 8 routes. Multi-route would normally admit, but week+ planned
  // reroutes are construction notices and CTA reposts them for the duration.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 37,
        headline: 'Temporary Reroute',
        shortDescription:
          'SB State will be closed between Wacker and Randolph. Board SB 2, 6, 10, 29, 36, 62, and 146 buses at State/Washington. Board SB 148 at Michigan/South Water.',
        busRoutes: ['2', '6', '10', '29', '36', '62', '146', '148'],
        eventStart: Date.parse('2026-04-13T14:00:00Z'),
        eventEnd: Date.parse('2026-05-25T05:00:00Z'),
      }),
    ),
    false,
  );
});

test('not significant: week-long multi-route stop relocation (Pulaski OL bus terminal)', () => {
  // Real alert 114529 from 2026-05-10: May 4 → May 11 bus terminal closure,
  // 3 routes. Stop relocations only — no service impact, week-long.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 37,
        headline: 'Pulaski Orange Line Station – Bus Terminal Temporary Bus Stop Relocations',
        shortDescription:
          'The bus terminal at the Pulaski Orange Line station will temporarily close for maintenance. #53, #53A, #62 buses will be rerouted.',
        busRoutes: ['53', '53A', '62'],
        eventStart: Date.parse('2026-05-04T13:00:00Z'),
        eventEnd: Date.parse('2026-05-11T21:00:00Z'),
      }),
    ),
    false,
  );
});

test('significant: high-severity reroute admits even when long-duration', () => {
  // Acute-incident severity (≥50) trumps the duration veto. Sev-50+ reroutes
  // never legitimately span weeks in practice — but if CTA mis-codes one,
  // we should still surface it rather than silently swallow.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 60,
        severityCss: 'major',
        headline: 'Major Police Activity Reroute',
        shortDescription:
          'Buses on routes 1, 2, 3 are rerouted indefinitely due to ongoing investigation.',
        busRoutes: ['1', '2', '3'],
        eventStart: Date.parse('2026-05-01T00:00:00Z'),
        eventEnd: Date.parse('2026-06-01T00:00:00Z'),
      }),
    ),
    true,
  );
});

test('significant: multi-route reroute admits when dates absent (unknown duration)', () => {
  // Treat unknown duration as short — better to over-admit than silently
  // drop multi-route reroutes that just happen to lack EventStart/EventEnd.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 37,
        headline: 'Temporary Reroute',
        shortDescription:
          '#136, #147 and #151 buses are rerouted between Devon/Sheridan-Broadway and Foster/Sheridan due to a CPD Funeral Service.',
        busRoutes: ['136', '147', '151'],
        eventStart: null,
        eventEnd: null,
      }),
    ),
    true,
  );
});

test('significant: high-severity single-route reroute admits (police activity)', () => {
  // Real alert from 2026-05-08: #84 Peterson police activity at sev 55.
  // The admit relies on CTA classifying the alert as non-minor in
  // `SeverityCSS` / `Impact` — `severityCss !== 'minor'` is what
  // distinguishes acute incidents from CTA-tagged minor reroutes that
  // happen to also score 55 (see 114870/114821 below).
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 55,
        severityCss: 'major',
        headline: '#84 Peterson Temporary Reroute near Bryn Mawr/Sheridan',
        shortDescription:
          '84 Peterson buses temp. rerouted: due to, police activity near Bryn Mawr/Sheridan.',
        busRoutes: ['84'],
      }),
    ),
    true,
  );
});

test('not significant: sev=55 reroute that CTA itself tags `SeverityCSS=minor`', () => {
  // Real alerts 114870 (#15 + #172 Hyde Park/Woodlawn) and 114821 (#72 North
  // at Kolmar): routine street-blockage reroutes scoring 55 but tagged
  // `Impact: "Minor Delays / Reroute"` / `SeverityCSS: "minor"` in the
  // same feed payload. Trust CTA's own label over the numeric score.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 55,
        severityCss: 'minor',
        impact: 'Minor Delays / Reroute',
        headline: '#15 Jeffery Local and #172 U. of Chicago/Kenwood Temporary Reroute',
        shortDescription:
          '15 Jeffery Local buses rrted via 51st, Woodlawn, and Lake Pk. and 172 U. of Chicago/Kenwood buses rrted via Woodlawn, 53rd, and Lake Pk nr Hyde Park/Woodlawn.',
        busRoutes: ['15', '172'],
      }),
    ),
    false,
  );
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 55,
        severityCss: 'minor',
        impact: 'Minor Delays / Reroute',
        headline: '#72 North Temporary Eastbound Reroute near North Ave./Kolmar',
        shortDescription:
          'EB 72 North buses are temporarily rerouted via North Avenue, Cicero, Grand, North Avenue and over regular route, due to street blockage near North Ave./Kolmar.',
        busRoutes: ['72'],
      }),
    ),
    false,
  );
});

test('normalizeAlert parses SeverityCSS and Impact', () => {
  const raw = {
    AlertId: '114870',
    Headline: '#15 Reroute',
    SeverityScore: '55',
    SeverityCSS: 'minor',
    Impact: 'Minor Delays / Reroute',
    MajorAlert: '0',
  };
  const a = normalizeAlert(raw);
  assert.equal(a.severityScore, 55);
  assert.equal(a.severityCss, 'minor');
  assert.equal(a.impact, 'Minor Delays / Reroute');
});

test('not significant: single-route reroute at default severity (block-party detour)', () => {
  // The dozens of sev=37 single-route reroutes on the live feed — local and
  // noisy, must still be vetoed.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 37,
        headline: 'Temporary Reroute',
        shortDescription:
          '#94 buses will operate via California, Archer, and Pershing, then resume their normal route on California.',
        busRoutes: ['94'],
      }),
    ),
    false,
  );
});

test('not significant: two-route reroute at default severity', () => {
  // Right at the boundary — 2 routes is below MULTI_ROUTE_THRESHOLD=3.
  assert.equal(
    isSignificantAlert(
      makeAlert({
        major: false,
        severityScore: 37,
        headline: 'Temporary Reroute',
        shortDescription: '#N5 and #67 buses will operate via 67th, Cottage Grove, Marquette.',
        busRoutes: ['N5', '67'],
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
