const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIncidents, postUrlRkey } = require('../bin/export-web');

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

test('pairs a CTA alert with a matching bot observation into one incident', () => {
  const incidents = buildIncidents([alert()], [obs({ ts: NOW + 5 * 60_000 })]);
  assert.equal(incidents.length, 1);
  const inc = incidents[0];
  assert.deepEqual(inc.sources, ['cta', 'bot']);
  assert.equal(inc.id, 'alertrkey'); // alert rkey preferred
  assert.ok(inc.cta);
  assert.equal(inc.cta.alert_id, 'alert-1');
  assert.equal(inc.observations.length, 1);
  assert.equal(inc.observations[0].from_station, 'Howard');
});

test('CTA alert with no matching observation is a cta-only incident', () => {
  const incidents = buildIncidents([alert()], []);
  assert.equal(incidents.length, 1);
  assert.deepEqual(incidents[0].sources, ['cta']);
  assert.equal(incidents[0].observations.length, 0);
  assert.ok(incidents[0].cta);
});

test('observation with no matching alert is a bot-only incident', () => {
  const incidents = buildIncidents([], [obs()]);
  assert.equal(incidents.length, 1);
  assert.deepEqual(incidents[0].sources, ['bot']);
  assert.equal(incidents[0].cta, null);
  assert.equal(incidents[0].id, 'obsrkey'); // obs rkey
  assert.deepEqual(incidents[0].routes, ['red']);
});

test('normalizes train line short codes to full names on both sides', () => {
  const incidents = buildIncidents(
    [alert({ routes: ['g'] })],
    [obs({ line: 'g', ts: NOW + 60_000 })],
  );
  assert.equal(incidents.length, 1, 'should still pair after normalization');
  assert.deepEqual(incidents[0].routes, ['green']);
  assert.equal(incidents[0].observations[0].line, 'green');
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
  assert.equal(incidents[0].observations.length, 2);
  assert.equal(incidents[0].observations[0].id, 1, 'closest obs is primary');
});

test('active incident reports no resolution even if a paired obs resolved', () => {
  const resolvedObs = obs({ resolved_ts: NOW + 10 * 60_000, active: false });
  const incidents = buildIncidents([alert({ active: true, resolved_ts: null })], [resolvedObs]);
  assert.equal(incidents[0].active, true);
  assert.equal(incidents[0].resolved_ts, null);
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
  assert.equal(incidents[0].cta.alert_id, 'a-new', 'newest first');
  assert.equal(incidents[0].resolved_ts, NOW + 30 * 60_000);
});
