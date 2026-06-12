const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIncidents, metraTrainNumberFromTripId, postUrlRkey } = require('../bin/export-web');

const NOW = 1_700_000_000_000;
const url = (rkey) => `https://bsky.app/profile/did:plc:abc/post/${rkey}`;

// Minimal built-alert object — the shape main() produces from an alert_posts
// row (post_uri already converted to a bsky URL, routes already split).
function alert(over = {}) {
  return {
    alert_id: 'alert-1',
    kind: 'train',
    routes: ['red'],
    headline: 'Red Line delays',
    short_description: null,
    first_seen_ts: NOW,
    resolved_ts: null,
    active: true,
    post_url: url('alertrkey'),
    resolved_reply_url: null,
    affected_from_station: null,
    affected_to_station: null,
    affected_direction: null,
    mentioned_stations: [],
    cta_event_start_ts: null,
    cta_event_end_ts: null,
    cta_event_start_is_date_only: false,
    cta_event_end_is_date_only: false,
    ...over,
  };
}

// Minimal built-observation object.
function obs(over = {}) {
  return {
    id: 1,
    kind: 'train',
    line: 'red',
    direction: null,
    from_station: 'Howard',
    to_station: 'Loyola',
    detection_source: 'pulse-cold',
    signals: null,
    evidence: null,
    ts: NOW,
    onset_ts: null,
    resolved_ts: null,
    active: true,
    post_url: url('obsrkey'),
    resolved_post_url: null,
    ...over,
  };
}

test('postUrlRkey extracts the rkey, null on missing/malformed', () => {
  assert.equal(postUrlRkey(url('abc123')), 'abc123');
  assert.equal(postUrlRkey(null), null);
  assert.equal(postUrlRkey('https://bsky.app/profile/x'), null);
});

test('metraTrainNumberFromTripId extracts the run number from static trip ids', () => {
  assert.equal(metraTrainNumberFromTripId('RI_RI428_V7_B'), '428');
  assert.equal(metraTrainNumberFromTripId('UP-W_UW31_V1_B'), '31');
  assert.equal(metraTrainNumberFromTripId(null), null);
});

test('pairs a CTA alert with a matching bot observation into one incident', () => {
  const incidents = buildIncidents([alert()], [obs({ ts: NOW + 5 * 60_000 })]);
  assert.equal(incidents.length, 1);
  const inc = incidents[0];
  assert.equal('kind' in inc, false);
  assert.equal('cta' in inc, false);
  assert.equal('observations' in inc, false);
  assert.equal('metra_status' in inc, false);
  assert.equal('active' in inc, false);
  assert.equal('first_seen_ts' in inc, false);
  assert.deepEqual(inc.sources, ['cta', 'bot']);
  assert.equal(inc.id, 'alertrkey'); // alert rkey preferred
  assert.equal(inc.agency, 'cta');
  assert.equal(inc.mode, 'train');
  assert.ok(inc.official_alert);
  assert.equal(inc.official_alert.id, 'alert-1');
  assert.equal(inc.detections.length, 1);
  assert.equal(inc.detections[0].scope.from_station, 'Howard');
});

test('CTA alert with no matching observation is a cta-only incident', () => {
  const incidents = buildIncidents([alert()], []);
  assert.equal(incidents.length, 1);
  assert.deepEqual(incidents[0].sources, ['cta']);
  assert.equal(incidents[0].detections.length, 0);
  assert.ok(incidents[0].official_alert);
});

test('official Metra delay alerts export a Metra status block', () => {
  const incidents = buildIncidents(
    [
      alert({
        kind: 'metra',
        routes: ['RI'],
        headline: 'RID #426 Delayed',
        delay_deadline_ts: NOW + 90 * 60_000,
        delay_min: 35,
        delay_train_no: '426',
      }),
    ],
    [],
  );
  assert.deepEqual(incidents[0].routes, ['ri']);
  assert.deepEqual(incidents[0].sources, ['metra']);
  assert.deepEqual(incidents[0].status, {
    type: 'delay',
    deadline_ts: NOW + 90 * 60_000,
    delay_min: 35,
    train_number: '426',
  });
});

test('merged Metra official alert and bot detection uses Metra as the official source', () => {
  const incidents = buildIncidents(
    [
      alert({
        kind: 'metra',
        routes: ['UP-N'],
        headline: 'UPN Train #366 Delayed',
        first_seen_ts: NOW,
      }),
    ],
    [
      obs({
        kind: 'metra',
        line: 'UP-N',
        ts: NOW + 5 * 60_000,
        detection_source: 'delay',
      }),
    ],
  );
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].agency, 'metra');
  assert.equal(incidents[0].mode, 'commuter_rail');
  assert.deepEqual(incidents[0].sources, ['metra', 'bot']);
});

test('official Metra delay alerts fall back to text classification when not schedule anchored', () => {
  const incidents = buildIncidents(
    [
      alert({
        kind: 'metra',
        routes: ['RI'],
        headline: 'RID #426 Delayed',
        short_description:
          'RID train #426, scheduled to arrive LaSalle Street Station at 3:36 PM, is operating 30 to 35 minutes behind schedule due to switch problems.',
      }),
    ],
    [],
  );
  assert.deepEqual(incidents[0].status, {
    type: 'delay',
    train_number: '426',
  });
});

test('official Metra delay text classifies the bare word "delay" (no minutes phrase)', () => {
  // Regression: "Remains Stopped ... Extensive delay anticipated" carries no
  // "N minutes behind" phrase, so it leans entirely on the word "delay". The
  // old /\bdelayed?\b/ only matched "delaye"/"delayed", left metra_status null,
  // and the event rendered without the delayed badge.
  const incidents = buildIncidents(
    [
      alert({
        kind: 'metra',
        routes: ['up-n'],
        headline: 'UPN Train #366- Remains Stopped',
        short_description:
          'UPN train #366, scheduled to arrive Ogilvie Transportation Center at 7:50 PM, remains stopped near Zion due to weather related conditions and a tree on the tracks. Extensive delay anticipated.',
      }),
    ],
    [],
  );
  assert.deepEqual(incidents[0].status, {
    type: 'delay',
    train_number: '366',
  });
});

test('official Metra planned-work delay alerts export planned-delay status', () => {
  const incidents = buildIncidents(
    [
      alert({
        kind: 'metra',
        routes: ['MD-W'],
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description:
          'Track construction will be taking place on Saturday, June 13 through Sunday, June 14. Trains may incur delays enroute up to 20 minutes behind scheduled passing through the work zone.',
      }),
    ],
    [],
  );
  assert.deepEqual(incidents[0].status, {
    type: 'planned-delay',
    train_number: null,
  });
});

test('consolidates same Metra planned-work notices across lines', () => {
  const description = (minutes) =>
    `Track construction will be taking place on Saturday, June 13 through Sunday, June 14. Trains may incur delays enroute up to ${minutes} minutes behind scheduled passing through the work zone. Please listen to announcements for any platform changes.`;
  const incidents = buildIncidents(
    [
      alert({
        alert_id: 'DevAPI-UPW',
        kind: 'metra',
        routes: ['UP-W'],
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description: description(15),
        first_seen_ts: NOW + 2 * 60_000,
        post_url: url('upw'),
      }),
      alert({
        alert_id: 'DevAPI-MDW',
        kind: 'metra',
        routes: ['MD-W'],
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description: description(20),
        first_seen_ts: NOW + 2 * 60_000,
        post_url: url('mdw'),
      }),
      alert({
        alert_id: 'DevAPI-BNSF',
        kind: 'metra',
        routes: ['BNSF'],
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description: description(15),
        first_seen_ts: NOW,
        post_url: url('bnsf'),
      }),
      alert({
        alert_id: 'DevAPI-ME',
        kind: 'metra',
        routes: ['ME'],
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description: description(30),
        first_seen_ts: NOW,
        post_url: url('me'),
      }),
      alert({
        alert_id: 'DevAPI-RI',
        kind: 'metra',
        routes: ['RI'],
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description: description(20),
        first_seen_ts: NOW + 60_000,
        post_url: url('ri'),
      }),
    ],
    [],
  );

  assert.equal(incidents.length, 1);
  const inc = incidents[0];
  assert.equal(inc.id, 'bnsf');
  assert.deepEqual(inc.routes, ['bnsf', 'md-w', 'me', 'ri', 'up-w']);
  assert.equal(inc.lifecycle.first_seen_ts, NOW);
  assert.equal(inc.lifecycle.active, true);
  assert.deepEqual(inc.status, { type: 'planned-delay', train_number: null });
  assert.equal(inc.official_alert.id, 'DevAPI-BNSF');
  assert.deepEqual(
    inc.official_alerts.map((a) => a.id),
    ['DevAPI-BNSF', 'DevAPI-ME', 'DevAPI-RI', 'DevAPI-MDW', 'DevAPI-UPW'],
  );
  assert.deepEqual(
    inc.official_alerts.map((a) => postUrlRkey(a.post_url)),
    ['bnsf', 'me', 'ri', 'mdw', 'upw'],
  );
});

test('does not consolidate non-planned Metra delays across lines', () => {
  const incidents = buildIncidents(
    [
      alert({
        alert_id: 'DevAPI-RI',
        kind: 'metra',
        routes: ['RI'],
        headline: 'RID #426 Delayed',
        short_description: 'RID train #426 is operating 30 minutes behind schedule.',
        post_url: url('ri-delay'),
      }),
      alert({
        alert_id: 'DevAPI-ME',
        kind: 'metra',
        routes: ['ME'],
        headline: 'MED #126 Delayed',
        short_description: 'MED train #126 is operating 30 minutes behind schedule.',
        post_url: url('me-delay'),
      }),
    ],
    [],
  );
  assert.equal(incidents.length, 2);
});

test('planned-work Metra notice does not absorb live per-train observations', () => {
  const incidents = buildIncidents(
    [
      alert({
        alert_id: 'DevAPI-UPNW',
        kind: 'metra',
        routes: ['UP-NW'],
        headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
        short_description:
          'Track construction will be taking place on Saturday, June 13 through Sunday, June 14. Trains may incur delays enroute up to 15 minutes behind scheduled passing through the work zone.',
        first_seen_ts: NOW,
        post_url: url('plannedwork'),
      }),
    ],
    [
      obs({
        id: 612,
        kind: 'metra',
        line: 'UP-NW',
        detection_source: 'delay',
        train_number: '612',
        ts: NOW + 5 * 60_000,
        post_url: url('delay612'),
      }),
      obs({
        id: 614,
        kind: 'metra',
        line: 'UP-NW',
        detection_source: 'cancellation',
        train_number: '614',
        ts: NOW + 20 * 60_000,
        post_url: url('cancel614'),
      }),
    ],
  );
  // The planned notice stays cta-only; the two live observations stand alone.
  assert.equal(incidents.length, 3);
  const planned = incidents.find((i) => i.official_alert?.id === 'DevAPI-UPNW');
  assert.deepEqual(planned.sources, ['metra']);
  assert.deepEqual(planned.detections, []);
  const botOnly = incidents.filter((i) => i.official_alert === null);
  assert.equal(botOnly.length, 2);
  assert.ok(botOnly.every((i) => i.sources.length === 1 && i.sources[0] === 'bot'));
});

test('official Metra cancellation alerts export cancellation status', () => {
  const incidents = buildIncidents(
    [
      alert({
        kind: 'metra',
        routes: ['RI'],
        headline: 'RID #424 Will Not Operate',
        cancellation: {
          state: 'cancelled',
          scheduled_departure_ts: NOW,
          scheduled_arrival_ts: NOW + 60 * 60_000,
          train_number: '424',
          origin: 'Joliet',
        },
      }),
    ],
    [],
  );
  assert.deepEqual(incidents[0].status, {
    type: 'cancellation',
    state: 'cancelled',
    scheduled_departure_ts: NOW,
    scheduled_arrival_ts: NOW + 60 * 60_000,
    train_number: '424',
    origin: 'Joliet',
  });
});

test('observation with no matching alert is a bot-only incident', () => {
  const incidents = buildIncidents([], [obs()]);
  assert.equal(incidents.length, 1);
  assert.deepEqual(incidents[0].sources, ['bot']);
  assert.equal(incidents[0].official_alert, null);
  assert.equal(incidents[0].id, 'obsrkey'); // obs rkey
  assert.deepEqual(incidents[0].routes, ['red']);
});

test('buildIncidents preserves affected_stations (cta) and stations (obs)', () => {
  const a = alert({
    affected_from_station: 'Belmont',
    affected_to_station: 'Howard',
    affected_stations: ['Belmont', 'Addison', 'Wilson', 'Howard'],
  });
  const o = obs({ ts: NOW + 5 * 60_000, stations: ['Howard', 'Jarvis', 'Loyola'] });
  const inc = buildIncidents([a], [o])[0];
  assert.deepEqual(inc.official_alert.scope.stations, ['Belmont', 'Addison', 'Wilson', 'Howard']);
  assert.deepEqual(inc.detections[0].scope.stations, ['Howard', 'Jarvis', 'Loyola']);
});

test('official alert scope defaults stations to [] when absent', () => {
  const inc = buildIncidents([alert()], [])[0];
  assert.deepEqual(inc.official_alert.scope.stations, []);
});

test('normalizes train line short codes to full names on both sides', () => {
  const incidents = buildIncidents(
    [alert({ routes: ['g'], headline: 'Green Line delays' })],
    [obs({ line: 'g', ts: NOW + 60_000 })],
  );
  assert.equal(incidents.length, 1, 'should still pair after normalization');
  assert.deepEqual(incidents[0].routes, ['green']);
  assert.equal(incidents[0].detections[0].scope.route, 'green');
});

test('does not merge across different routes', () => {
  const incidents = buildIncidents([alert({ routes: ['red'] })], [obs({ line: 'blue' })]);
  assert.equal(incidents.length, 2);
  assert.ok(incidents.every((i) => i.sources.length === 1));
});

test('does not merge an observation that resolved well before the alert fired', () => {
  const stale = obs({
    ts: NOW - 3 * 60 * 60_000, // 3h before — outside the 2h window
    resolved_ts: NOW - 3 * 60 * 60_000 + 60_000,
    active: false,
  });
  const incidents = buildIncidents([alert()], [stale]);
  assert.equal(incidents.length, 2, 'stale obs stays standalone');
});

test('multiple matching observations ride along, primary (closest) first', () => {
  const near = obs({ id: 1, ts: NOW + 2 * 60_000, post_url: url('near') });
  const far = obs({ id: 2, ts: NOW + 90 * 60_000, post_url: url('far') });
  const incidents = buildIncidents([alert()], [far, near]);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].detections.length, 2);
  assert.equal(incidents[0].detections[0].id, 1, 'closest obs is primary');
});

test('active incident reports no resolution even if a paired obs resolved', () => {
  const resolvedObs = obs({ resolved_ts: NOW + 10 * 60_000, active: false });
  const incidents = buildIncidents([alert({ active: true, resolved_ts: null })], [resolvedObs]);
  assert.equal(incidents[0].lifecycle.active, true);
  assert.equal(incidents[0].lifecycle.resolved_ts, null);
});

test('merged incident first_seen_ts is the earliest of CTA and bot onset', () => {
  // Mirrors event 3mmsa2hmli42h: the bot post landed AFTER CTA, but its
  // back-dated onset_ts (last train through the cold stretch) was 30 min
  // before CTA fired.
  const earlyObs = obs({
    id: 1,
    ts: NOW + 5 * 60_000,
    onset_ts: NOW - 30 * 60_000,
  });
  const incidents = buildIncidents([alert({ first_seen_ts: NOW })], [earlyObs]);
  assert.equal(incidents.length, 1);
  const inc = incidents[0];
  assert.equal(
    inc.lifecycle.first_seen_ts,
    NOW - 30 * 60_000,
    'uses earliest onset across sources',
  );
  assert.equal(
    inc.official_alert.lifecycle.first_seen_ts,
    NOW,
    'official block keeps its own post time',
  );
});

test('merged first_seen_ts falls back to obs.ts when onset_ts is null', () => {
  const o = obs({ id: 1, ts: NOW - 10 * 60_000, onset_ts: null });
  const incidents = buildIncidents([alert({ first_seen_ts: NOW })], [o]);
  assert.equal(incidents[0].lifecycle.first_seen_ts, NOW - 10 * 60_000);
});

test('routes union across versions preserves lines CTA dropped before resolving', () => {
  // Mirrors event 3mmsa2hmli42h: CTA started multi-line, then edited the
  // headline down to just Brown before clearing — the snapshot in
  // alert_posts.routes loses Red and Purple entirely.
  const a = alert({
    routes: ['brown'],
    headline: 'Brown Line Service Running with Delays near Belmont',
    versions: [
      { ts: NOW, headline: 'Kimball-bound Brown and Linden-bound Purple Line Service Delayed' },
      {
        ts: NOW + 60_000,
        headline: 'Brown, Red and Purple Line Service Delayed near Belmont',
      },
      { ts: NOW + 120_000, headline: 'Brown Line Service Running with Delays near Belmont' },
    ],
  });
  const incidents = buildIncidents([a], []);
  assert.deepEqual(incidents[0].routes, ['red', 'brown', 'purple']);
});

test('routes union also folds in matched observation lines', () => {
  const a = alert({ routes: ['brown'], headline: 'Brown Line Service Delayed' });
  const o = obs({ line: 'brown', ts: NOW + 60_000 });
  const incidents = buildIncidents([a], [o]);
  assert.deepEqual(incidents[0].routes, ['brown']);
});

test('bus incidents keep alert.routes as-is (no train-line text mining)', () => {
  const a = alert({
    kind: 'bus',
    routes: ['9'],
    headline: 'Route 9 reroute — Red Line construction',
  });
  const incidents = buildIncidents([a], []);
  assert.deepEqual(incidents[0].routes, ['9']);
});

test('merged first_seen_ts stays on CTA when CTA fired first', () => {
  const o = obs({ id: 1, ts: NOW + 5 * 60_000, onset_ts: NOW + 3 * 60_000 });
  const incidents = buildIncidents([alert({ first_seen_ts: NOW })], [o]);
  assert.equal(incidents[0].lifecycle.first_seen_ts, NOW);
});

test('resolved incident takes alert resolved_ts; incidents sort newest-first', () => {
  const older = alert({
    alert_id: 'a-old',
    first_seen_ts: NOW - 60 * 60_000,
    post_url: url('old'),
  });
  const newer = alert({
    alert_id: 'a-new',
    first_seen_ts: NOW,
    resolved_ts: NOW + 30 * 60_000,
    active: false,
    post_url: url('new'),
  });
  const incidents = buildIncidents([older, newer], []);
  assert.equal(incidents[0].official_alert.id, 'a-new', 'newest first');
  assert.equal(incidents[0].lifecycle.resolved_ts, NOW + 30 * 60_000);
});
