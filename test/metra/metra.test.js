const { test } = require('node:test');
const assert = require('node:assert');

const lines = require('../../src/metra/lines');
const { parsePosition, parseTripUpdate, parseAlert } = require('../../src/metra/api');
const {
  parseGtfsTime,
  buildLineGeometry,
  buildLineStations,
} = require('../../scripts/fetch-metra-gtfs');
const {
  isSignificantMetraAlert,
  alertRelevance,
  buildMetraAlertText,
  buildMetraResolutionCardTitle,
  buildMetraCloseCardTitle,
} = require('../../src/metra/metraAlerts');
const { resolvedEventLink } = require('../../src/shared/eventLink');
const {
  buildLineCorridor,
  decimatePolyline,
  buildMetraTracks,
  computeMetraSamples,
  directionLabel,
} = require('../../src/metra/speedmap');
const { detectCancellations, isFeedHealthy } = require('../../src/metra/cancellations');
const { activeServiceIds, scheduledDeparturesInWindow } = require('../../src/metra/schedule');
const {
  classifyCancellationAlert,
  isCancellationText,
  runNumberFromTripId,
  extractTrainNumbers,
} = require('../../src/metra/cancellationAlert');
const {
  buildRollupPosts,
  renderBullets,
  buildDelayPosts,
} = require('../../bin/metra/cancellations');

// --- lines.js ---

test('all 11 lines have a name, color, and text color', () => {
  assert.strictEqual(lines.ALL_LINES.length, 11);
  for (const l of lines.ALL_LINES) {
    assert.ok(lines.LINE_NAMES[l], `${l} has a name`);
    assert.match(lines.LINE_COLORS[l], /^[0-9A-F]{6}$/i, `${l} color is a hex`);
    assert.match(lines.LINE_TEXT_COLORS[l], /^[0-9A-F]{6}$/i, `${l} text color is a hex`);
  }
});

test('lineLabel falls back to the raw id for unknown lines', () => {
  assert.strictEqual(lines.lineLabel('UP-N'), 'Union Pacific North');
  assert.strictEqual(lines.lineLabel('ZZ'), 'ZZ');
});

test('webKey lowercases the route id and is null-safe', () => {
  assert.strictEqual(lines.webKey('MD-W'), 'md-w');
  assert.strictEqual(lines.webKey(null), null);
});

// --- api.js normalizers (decoded-entity shaped inputs) ---

test('parsePosition pulls trip, position, vehicle, and timestamp', () => {
  const entity = {
    vehicle: {
      trip: { tripId: 'BNSF_BN1272_V2_B', routeId: 'BNSF', scheduleRelationship: 0 },
      position: { latitude: 41.85, longitude: -87.9, bearing: 270 },
      vehicle: { id: '8474', label: '1272' },
      timestamp: 1781043109,
    },
  };
  const p = parsePosition(entity);
  assert.strictEqual(p.tripId, 'BNSF_BN1272_V2_B');
  assert.strictEqual(p.routeId, 'BNSF');
  assert.strictEqual(p.label, '1272');
  assert.strictEqual(p.scheduleRelationship, 'SCHEDULED');
  assert.strictEqual(p.lat, 41.85);
  assert.strictEqual(p.ts, 1781043109);
});

test('parsePosition returns null when there is no vehicle payload', () => {
  assert.strictEqual(parsePosition({ tripUpdate: {} }), null);
});

test('parseTripUpdate maps stop updates and CANCELED relationship', () => {
  const entity = {
    tripUpdate: {
      trip: { tripId: 'UP-W_UW60_V2_B', routeId: 'UP-W', scheduleRelationship: 3 },
      vehicle: { label: '60' },
      timestamp: 1781043173,
      stopTimeUpdate: [
        { stopSequence: 1, stopId: 'ELBURN', scheduleRelationship: 2 },
        {
          stopSequence: 28,
          stopId: 'CUS',
          scheduleRelationship: 0,
          arrival: { time: 1781043533, delay: 120 },
        },
      ],
    },
  };
  const tu = parseTripUpdate(entity);
  assert.strictEqual(tu.tripId, 'UP-W_UW60_V2_B');
  assert.strictEqual(tu.scheduleRelationship, 'CANCELED');
  assert.strictEqual(tu.stopUpdates.length, 2);
  assert.strictEqual(tu.stopUpdates[0].scheduleRelationship, 'NO_DATA');
  assert.strictEqual(tu.stopUpdates[1].arrivalTime, 1781043533);
  assert.strictEqual(tu.stopUpdates[1].delay, 120);
});

// Real-wire regression: replay a fixture of LIVE CANCELED trips (captured from
// the Metra feed during a 2026-06-10 weather disruption via
// scripts/capture-metra-cancellation.js) through the FULL decode path —
// FeedMessage.decode of the actual protobuf bytes → parseTripUpdate. Confirms
// Metra really encodes cancellations as trip-level schedule_relationship=CANCELED
// (enum 3), not via an alert or stop-level flags, and that a canceled trip
// carries zero stopTimeUpdates on the wire. This was the Phase 0 open item.
test('decodes a real captured CANCELED trip from raw feed bytes', () => {
  const { transit_realtime } = require('gtfs-realtime-bindings');
  const fixture = require('./fixtures/canceled-tripupdates.json');

  assert.strictEqual(fixture.canceledEnumValue, 3, 'CANCELED is wire enum 3');

  const tuFeed = transit_realtime.FeedMessage.decode(Buffer.from(fixture.tripUpdatesB64, 'base64'));
  const updates = tuFeed.entity.map(parseTripUpdate);
  assert.ok(updates.length >= 1, 'fixture has at least one canceled tripUpdate');
  for (const u of updates) {
    assert.strictEqual(u.scheduleRelationship, 'CANCELED');
    assert.ok(u.tripId && u.routeId, 'canceled trip still carries trip + route ids');
    assert.strictEqual(u.stopUpdates.length, 0, 'a canceled trip ships no stop updates');
  }

  if (fixture.positionsB64) {
    const posFeed = transit_realtime.FeedMessage.decode(
      Buffer.from(fixture.positionsB64, 'base64'),
    );
    for (const p of posFeed.entity.map(parsePosition)) {
      assert.strictEqual(p.scheduleRelationship, 'CANCELED');
    }
  }
});

test('parseAlert extracts informed entity, effect, and translated text', () => {
  const entity = {
    id: 'DevAPI-1',
    alert: {
      informedEntity: [{ agencyId: 'METRA', routeId: 'NCS' }],
      cause: 1,
      effect: 8,
      headerText: { translation: [{ text: 'NCS - ADA Accessibility', language: 'en' }] },
      descriptionText: { translation: [{ text: 'Station construction.', language: 'en' }] },
    },
  };
  const a = parseAlert(entity);
  assert.strictEqual(a.id, 'DevAPI-1');
  assert.strictEqual(a.informedEntities[0].routeId, 'NCS');
  assert.strictEqual(a.header, 'NCS - ADA Accessibility');
  assert.strictEqual(a.description, 'Station construction.');
  // effect 8 is UNKNOWN_EFFECT in the GTFS-rt enum — Metra's common default.
  assert.strictEqual(a.effect, 'UNKNOWN_EFFECT');
});

// --- fetch-metra-gtfs.js pure helpers ---

test('parseGtfsTime handles >24h times and blanks', () => {
  assert.strictEqual(parseGtfsTime('04:08:00'), 4 * 3600 + 8 * 60);
  assert.strictEqual(parseGtfsTime('25:15:00'), 25 * 3600 + 15 * 60);
  assert.strictEqual(parseGtfsTime(''), null);
  assert.strictEqual(parseGtfsTime(null), null);
});

test('buildLineGeometry groups every shape used by a line into polylines', () => {
  const trips = {
    t1: { route_id: 'BNSF', shape_id: 'BNSF_IB_1' },
    t2: { route_id: 'BNSF', shape_id: 'BNSF_OB_1' },
    t3: { route_id: 'BNSF', shape_id: 'BNSF_IB_1' }, // dup shape — collapses
  };
  const byShape = new Map([
    [
      'BNSF_IB_1',
      [
        { seq: 2, lat: 41.7, lon: -88.3 },
        { seq: 4, lat: 41.8, lon: -88.2 },
      ],
    ],
    [
      'BNSF_OB_1',
      [
        { seq: 2, lat: 41.8, lon: -88.2 },
        { seq: 4, lat: 41.7, lon: -88.3 },
      ],
    ],
  ]);
  const geo = buildLineGeometry(trips, byShape);
  assert.strictEqual(geo.BNSF.length, 2);
  assert.deepStrictEqual(geo.BNSF[0][0], [41.7, -88.3]);
});

test('buildLineStations uses the longest trip and maps through stops', () => {
  const trips = {
    short: { route_id: 'UP-W', stop_times: [{ stop_id: 'A', stop_sequence: 1 }] },
    long: {
      route_id: 'UP-W',
      stop_times: [
        { stop_id: 'A', stop_sequence: 1 },
        { stop_id: 'B', stop_sequence: 2 },
      ],
    },
  };
  const stops = {
    A: { name: 'Elburn', lat: 41.8, lon: -88.5 },
    B: { name: 'La Fox', lat: 41.9, lon: -88.4 },
  };
  const st = buildLineStations(trips, stops);
  assert.strictEqual(st['UP-W'].length, 2);
  assert.deepStrictEqual(st['UP-W'][0], { id: 'A', name: 'Elburn', lat: 41.8, lon: -88.5 });
});

// --- metraAlerts.js significance gate ---

function alert({ route = 'BNSF', header = '', description = '', effect = 'UNKNOWN_EFFECT' } = {}) {
  const informedEntities =
    route === null ? [{ agencyId: 'METRA' }] : [{ agencyId: 'METRA', routeId: route }];
  return { id: 'X', informedEntities, effect, header, description };
}

test('alert gate admits a real cancellation', () => {
  assert.ok(
    isSignificantMetraAlert(
      alert({
        header: 'UPW train #56 will not operate',
        description: 'due to a mechanical failure',
      }),
    ),
  );
});

test('alert gate rejects ADA / construction / elevator notices', () => {
  assert.ok(
    !isSignificantMetraAlert(
      alert({
        header: 'NCS - Grayslake ADA Accessibility',
        description: 'use alternate boarding stations during station construction',
      }),
    ),
  );
  assert.ok(!isSignificantMetraAlert(alert({ header: 'Kenosha Elevator Out of Service' })));
  assert.ok(!isSignificantMetraAlert(alert({ header: 'Kedzie Station Construction' })));
});

test('alert gate requires a magnitude for delays (bare "delay" is not major)', () => {
  assert.ok(
    !isSignificantMetraAlert(alert({ description: 'minor delay expected during construction' })),
  );
  assert.ok(
    isSignificantMetraAlert(
      alert({ header: 'Train 334', description: 'operating 22 to 27 minutes behind schedule' }),
    ),
  );
});

test('alert gate admits on a strong structured effect regardless of keywords', () => {
  assert.ok(isSignificantMetraAlert(alert({ header: 'Service note', effect: 'NO_SERVICE' })));
});

test('alertRelevance distinguishes line-scoped from agency-wide', () => {
  assert.deepStrictEqual(alertRelevance(alert({ route: 'ME' })).lines, ['ME']);
  const wide = alertRelevance(alert({ route: null }));
  assert.ok(wide.agencyWide && wide.lines.length === 0 && wide.relevant);
});

test('buildMetraAlertText is Metra-branded and within the post limit', () => {
  const text = buildMetraAlertText(
    alert({ header: 'UPW train #56 will not operate', description: 'x'.repeat(400) }),
  );
  assert.match(text, /Per Metra/);
  assert.ok([...text].length <= 300);
});

test('buildMetraResolutionCardTitle is a clean, emoji-free archive headline', () => {
  assert.strictEqual(
    buildMetraResolutionCardTitle('UPW train #56 will not operate'),
    'Metra reports this is resolved: UPW train #56 will not operate',
  );
  // Falls back when no header, never empty.
  assert.match(buildMetraResolutionCardTitle(null), /Metra reports this is resolved:/);
});

test('resolution reply links to the Metra incident archive page (/resolved variant)', () => {
  // The rkey of the original alert post is the event page id on the archive.
  const link = resolvedEventLink(
    'at://did:plc:abc/app.bsky.feed.post/3kxyzpostrkey',
    buildMetraResolutionCardTitle('Heritage Corridor delays'),
  );
  assert.strictEqual(link.url, 'https://chicagotransitalerts.app/event/3kxyzpostrkey/resolved');
  assert.match(link.thumbUrl, /\/resolved\/og\.png$/);
  assert.match(link.title, /Metra reports this is resolved: Heritage Corridor delays/);
});

test('buildMetraCloseCardTitle is neutral — the headline, no "resolved" claim', () => {
  assert.strictEqual(
    buildMetraCloseCardTitle('UPNW Train #655 - delayed'),
    'UPNW Train #655 - delayed',
  );
  assert.doesNotMatch(buildMetraCloseCardTitle('UPW train #56 will not operate'), /resolved/i);
  // Falls back when no header, never empty.
  assert.match(buildMetraCloseCardTitle(null), /Metra service alert/);
});

// --- speedmap detector ---

test('buildLineCorridor returns the longest polyline for a line', () => {
  const geo = {
    BNSF: [
      [
        [41.7, -88.3],
        [41.71, -88.2],
      ],
      [
        [41.7, -88.3],
        [41.71, -88.2],
        [41.72, -88.1],
        [41.73, -88.0],
      ],
    ],
  };
  const c = buildLineCorridor(geo, 'BNSF');
  assert.strictEqual(c.points.length, 4);
  assert.ok(c.totalFt > 0 && c.cumDist.length === 4);
  assert.strictEqual(buildLineCorridor(geo, 'NOPE'), null);
});

test('buildMetraTracks groups by trip and resolves direction from the index', () => {
  const rows = [
    { ts: 1, trip_id: 'T1', lat: 41.7, lon: -88.3 },
    { ts: 2, trip_id: 'T1', lat: 41.71, lon: -88.2 },
    { ts: 1, trip_id: 'T2', lat: 41.8, lon: -88.1 },
  ];
  const tracks = buildMetraTracks(rows, { T1: { direction_id: 1 }, T2: { direction_id: 0 } });
  assert.strictEqual(tracks.get('T1').get('1').length, 2);
  assert.strictEqual(tracks.get('T2').get('0').length, 1);
});

test('computeMetraSamples yields a plausible mph for a ~0.8mi/60s hop', () => {
  const geo = {
    L: [
      [
        [41.85, -87.9],
        [41.86, -87.9],
        [41.87, -87.9],
        [41.88, -87.9],
      ],
    ],
  };
  const c = buildLineCorridor(geo, 'L');
  const rows = [
    { ts: 0, route: 'L', trip_id: 'T1', lat: 41.852, lon: -87.9 },
    { ts: 60000, route: 'L', trip_id: 'T1', lat: 41.864, lon: -87.9 },
  ];
  const { byDir } = computeMetraSamples(rows, c, { T1: { direction_id: 1 } });
  const samples = byDir.get('1');
  assert.ok(samples && samples.length === 1);
  assert.ok(samples[0].mph > 20 && samples[0].mph < 90, `mph ${samples[0].mph}`);
});

test('decimatePolyline thins dense vertices but keeps endpoints', () => {
  // 100 points spaced ~100 ft apart along a meridian (~111 ft/0.0003 deg lat).
  const pts = Array.from({ length: 100 }, (_, i) => [41.8 + i * 0.0003, -87.9]);
  const out = decimatePolyline(pts, 1320);
  assert.ok(out.length < pts.length, 'thinned');
  assert.deepStrictEqual(out[0], pts[0], 'keeps first');
  assert.deepStrictEqual(out[out.length - 1], pts[pts.length - 1], 'keeps last');
  // A short 2-point line is returned unchanged.
  assert.strictEqual(
    decimatePolyline([
      [41.8, -87.9],
      [41.9, -87.9],
    ]).length,
    2,
  );
});

test('directionLabel maps GTFS direction_id to rider labels', () => {
  assert.strictEqual(directionLabel('1'), 'Inbound');
  assert.strictEqual(directionLabel('0'), 'Outbound');
  assert.strictEqual(directionLabel('unknown'), 'Unknown direction');
});

// --- cancellation detector ---

const T = (id, route, depMs, extra = {}) => ({
  tripId: id,
  route,
  scheduledDepMs: depMs,
  serviceDate: '20260609',
  headsign: 'Chicago',
  ...extra,
});

test('detectCancellations passes confirmed through and tags source', () => {
  const { confirmed, inferred } = detectCancellations({
    canceledTrips: [T('A', 'BNSF', 0)],
    candidateTrips: [],
    now: 1000,
  });
  assert.strictEqual(confirmed.length, 1);
  assert.strictEqual(confirmed[0].source, 'cancellation');
  assert.strictEqual(inferred.length, 0);
});

test('detectCancellations infers a departed, never-seen trip', () => {
  const now = 100 * 60000;
  const { inferred } = detectCancellations({
    candidateTrips: [T('A', 'BNSF', now - 30 * 60000)], // departed 30 min ago
    observedTripIds: new Set(),
    livePredictionTripIds: new Set(),
    now,
    feedHealthy: true,
  });
  assert.strictEqual(inferred.length, 1);
  assert.strictEqual(inferred[0].source, 'cancellation-inferred');
});

test('detectCancellations does NOT infer when the trip was observed, predicted, canceled, or alerted', () => {
  const now = 100 * 60000;
  const dep = now - 30 * 60000;
  const base = { candidateTrips: [T('A', 'BNSF', dep)], now, feedHealthy: true };
  assert.strictEqual(
    detectCancellations({ ...base, observedTripIds: new Set(['A']) }).inferred.length,
    0,
  );
  assert.strictEqual(
    detectCancellations({ ...base, livePredictionTripIds: new Set(['A']) }).inferred.length,
    0,
  );
  assert.strictEqual(
    detectCancellations({ ...base, alertCoveredTripIds: new Set(['A']) }).inferred.length,
    0,
  );
  assert.strictEqual(
    detectCancellations({ ...base, canceledTrips: [T('A', 'BNSF', dep)] }).inferred.length,
    0,
  );
});

test('detectCancellations respects the grace window (recent departure is not yet a ghost)', () => {
  const now = 100 * 60000;
  const { inferred } = detectCancellations({
    candidateTrips: [T('A', 'BNSF', now - 5 * 60000)], // only 5 min ago < 15 min grace
    now,
    feedHealthy: true,
  });
  assert.strictEqual(inferred.length, 0);
});

test('detectCancellations suppresses the inferred layer when the feed is unhealthy', () => {
  const now = 100 * 60000;
  const out = detectCancellations({
    canceledTrips: [T('A', 'BNSF', 0)],
    candidateTrips: [T('B', 'UP-N', now - 30 * 60000)],
    now,
    feedHealthy: false,
  });
  assert.strictEqual(out.confirmed.length, 1, 'confirmed still reported');
  assert.strictEqual(out.inferred.length, 0, 'inferred suppressed');
});

test('isFeedHealthy: fresh + continuous is healthy, stale or gappy is not', () => {
  const now = 100 * 60000;
  const cont = [];
  for (let t = now - 28 * 60000; t <= now; t += 60000) cont.push(t); // every minute
  assert.ok(isFeedHealthy(cont, now));
  assert.ok(!isFeedHealthy([now - 20 * 60000], now), 'stale newest'); // nothing fresh
  assert.ok(!isFeedHealthy([], now), 'empty');
  const gappy = [now - 28 * 60000, now]; // 28-min gap
  assert.ok(!isFeedHealthy(gappy, now), 'internal gap');
});

// --- rollup text + schedule helpers ---

// Realtime/static Metra trip_ids embed the rider-facing train number (BN1272 → 1272).
const trip = (route, no) => ({ route, tripId: `${route}_X${no}_V2_B` });
const lateTrip = (route, no, delayMin) => ({ ...trip(route, no), delayMin });
const len = (s) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;

test('renderBullets lists train numbers per line, busiest line first', () => {
  const bullets = renderBullets([trip('BNSF', 1272), trip('BNSF', 1284), trip('RI', 401)]);
  assert.deepStrictEqual(bullets, ['• BNSF: #1272, #1284', '• Rock Island: #401']);
});

test('renderBullets caps a busy line with "+N more"', () => {
  const evs = [10, 11, 12, 13, 14, 15, 16, 17].map((n) => trip('BNSF', n));
  const [bullet] = renderBullets(evs);
  assert.match(bullet, /• BNSF: #10, #11, #12, #13, #14, #15, \+2 more/);
});

test('buildDelayPosts groups delays into severity tiers, worst first, no minutes', () => {
  const posts = buildDelayPosts(
    [
      lateTrip('UP-W', 65, 18),
      lateTrip('UP-W', 71, 16),
      lateTrip('BNSF', 1276, 32),
      lateTrip('RI', 401, 72),
    ],
    250,
  );
  assert.strictEqual(posts.length, 1);
  const text = posts[0];
  assert.match(text, /^🐌 Delays\n/);
  assert.match(text, /60\+ min\n• Rock Island: #401/);
  assert.match(text, /30–44 min\n• BNSF: #1276/);
  assert.match(text, /15–29 min\n• Union Pacific West: #65, #71/);
  // worst tier first, and no per-train "(N min)"
  assert.ok(text.indexOf('60+ min') < text.indexOf('30–44 min'));
  assert.ok(text.indexOf('30–44 min') < text.indexOf('15–29 min'));
  assert.doesNotMatch(text, /\(\d+ min\)/);
});

test('buildDelayPosts omits empty tiers', () => {
  const [post] = buildDelayPosts([lateTrip('BNSF', 1276, 22)], 250);
  assert.match(post, /15–29 min\n• BNSF: #1276/);
  assert.doesNotMatch(post, /60\+ min/);
  assert.doesNotMatch(post, /30–44 min/);
});

test('buildRollupPosts threads cancellations, not-seen, then one grouped delays post', () => {
  const posts = buildRollupPosts(
    [trip('BNSF', 1272), trip('BNSF', 1284)],
    [trip('UP-W', 65)],
    [lateTrip('RI', 401, 22)],
  );
  assert.strictEqual(posts.length, 3);
  // root: header + worst signal (confirmed cancellations) with train numbers
  assert.match(posts[0], /🚆 Metra · past hour/);
  assert.match(posts[0], /❌ Cancelled\n• BNSF: #1272, #1284/);
  // reply: the hedged inferred layer
  assert.match(posts[1], /⚠️ Scheduled but not seen \(unconfirmed\)\n• Union Pacific West: #65/);
  // last reply: one grouped delays post (bucketed), plus the provenance footer
  assert.match(posts[2], /🐌 Delays\n\n15–29 min\n• Rock Island: #401/);
  assert.match(posts[2], /Per Metra realtime data\./);
  // header/footer live only on root/last — never repeated mid-thread
  assert.doesNotMatch(posts[1], /Metra · past hour/);
  assert.doesNotMatch(posts[0], /Per Metra realtime data/);
});

test('buildRollupPosts is a single grouped post when only delays fire', () => {
  const posts = buildRollupPosts([], [], [lateTrip('BNSF', 1272, 20), lateTrip('RI', 401, 50)]);
  assert.strictEqual(posts.length, 1);
  assert.match(posts[0], /🚆 Metra · past hour/);
  assert.match(posts[0], /🐌 Delays/);
  assert.match(posts[0], /45–59 min\n• Rock Island: #401/);
  assert.match(posts[0], /15–29 min\n• BNSF: #1272/);
  assert.match(posts[0], /Per Metra realtime data\./);
});

test('buildRollupPosts is empty when there is nothing to report', () => {
  assert.deepStrictEqual(buildRollupPosts([], [], []), []);
});

test('every post stays under the 300-grapheme cap, even on a heavy hour', () => {
  // Every line, several trains each, spread across delay tiers — worst case.
  const all = ['BNSF', 'HC', 'MD-N', 'MD-W', 'ME', 'NCS', 'RI', 'SWS', 'UP-N', 'UP-NW', 'UP-W'];
  const cancels = all.flatMap((r) => [1, 2, 3, 4].map((n) => trip(r, 1000 + n)));
  const delays = all.flatMap((r) => [18, 33, 48, 70].map((m, i) => lateTrip(r, 2000 + i, m)));
  const posts = buildRollupPosts(cancels, cancels, delays);
  assert.ok(posts.length >= 3, 'heavy hour threads (and may spill to cont. posts)');
  for (const p of posts) assert.ok(len(p) <= 300, `post within limit: ${len(p)}`);
});

// --- delays detector ---

test('computeMaxDelays derives delay from predicted − scheduled, worst stop per trip', () => {
  const { computeMaxDelays } = require('../../src/metra/delays');
  // scheduled: A@1000s, B@1200s. Trip T predicted A late by 1200s, B late by 1320s.
  const sched = { 'T|A': 1000, 'T|B': 1200 };
  const scheduledArrFor = (trip, stop) => sched[`${trip}|${stop}`] ?? null;
  const rows = [
    { tripId: 'T', route: 'BNSF', stopId: 'A', predictedArr: 2200 }, // +1200s
    { tripId: 'T', route: 'BNSF', stopId: 'B', predictedArr: 2520 }, // +1320s (worst)
    { tripId: 'T', route: 'BNSF', stopId: 'Z', predictedArr: 9999 }, // unknown stop → ignored
  ];
  const out = computeMaxDelays(rows, scheduledArrFor);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].maxDelay, 1320);
});

test('significantDelays keeps trains at/over the threshold and sorts worst-first', () => {
  const { significantDelays, DELAY_THRESHOLD_SEC } = require('../../src/metra/delays');
  const rows = [
    { tripId: 'A', route: 'BNSF', maxDelay: 5 * 60 }, // under threshold → dropped
    { tripId: 'B', route: 'UP-N', maxDelay: 18 * 60 },
    { tripId: 'C', route: 'RI', maxDelay: 32 * 60 },
    { tripId: 'D', route: 'ME', maxDelay: null }, // no data → dropped
  ];
  const out = significantDelays(rows, DELAY_THRESHOLD_SEC);
  assert.deepStrictEqual(
    out.map((d) => d.tripId),
    ['C', 'B'],
  );
  assert.strictEqual(out[0].delayMin, 32);
  assert.strictEqual(out[0].source, 'delay');
});

test('activeServiceIds applies day-of-week + calendar_dates exceptions', () => {
  const index = {
    calendar: {
      WK: {
        days: [true, true, true, true, true, false, false],
        start_date: '20260101',
        end_date: '20261231',
      },
      SAT: {
        days: [false, false, false, false, false, true, false],
        start_date: '20260101',
        end_date: '20261231',
      },
    },
    calendarDates: [
      // On this one Tuesday, remove the weekday service and add Saturday service.
      { service_id: 'WK', date: '20260609', exception_type: 2 },
      { service_id: 'SAT', date: '20260609', exception_type: 1 },
    ],
  };
  // 20260616 is a plain Tuesday (no exceptions) → WK active.
  assert.deepStrictEqual([...activeServiceIds(index, '20260616')], ['WK']);
  // 20260609 (Tuesday) base is WK, but the exceptions remove WK and add SAT.
  assert.deepStrictEqual([...activeServiceIds(index, '20260609')], ['SAT']);
});

test('scheduledDeparturesInWindow resolves a trip to a concrete departure', () => {
  const index = {
    calendar: {
      WK: {
        days: [true, true, true, true, true, false, false],
        start_date: '20260101',
        end_date: '20261231',
      },
    },
    calendarDates: [],
    trips: {
      T1: {
        route_id: 'BNSF',
        service_id: 'WK',
        headsign: 'Chicago Union Station',
        direction_id: 1,
        stop_times: [
          { stop_id: 'AURORA', stop_sequence: 1, departure: 16 * 3600 + 10 * 60 }, // 16:10
          { stop_id: 'CUS', stop_sequence: 28, arrival: 17 * 3600 + 15 * 60 },
        ],
      },
    },
  };
  // Tuesday 20260609, wide window covering all day.
  const now = Date.UTC(2026, 5, 9, 23, 0, 0); // ~6pm CT
  const deps = scheduledDeparturesInWindow(index, now - 20 * 3600e3, now, now);
  const t1 = deps.find((d) => d.tripId === 'T1');
  assert.ok(t1, 'resolved T1');
  assert.strictEqual(t1.route, 'BNSF');
  assert.strictEqual(t1.originStopId, 'AURORA');
  assert.strictEqual(t1.destStopId, 'CUS');
  assert.strictEqual(t1.directionId, 1);
});

test('tripKey strips the service-variant suffix so feed and schedule match', () => {
  const { tripKey } = require('../../src/metra/schedule');
  assert.strictEqual(tripKey('BNSF_BN1275_V2_A'), 'BNSF_BN1275_V2');
  assert.strictEqual(tripKey('BNSF_BN1275_V2_B'), 'BNSF_BN1275_V2');
  assert.strictEqual(tripKey(null), null);
});

test('detectCancellations clears an inferred candidate observed under a different suffix', () => {
  const { tripKey } = require('../../src/metra/schedule');
  const now = 100 * 60000;
  // scheduled as _A, observed as _B → must NOT infer once keyOf normalizes.
  const { inferred } = detectCancellations({
    candidateTrips: [T('BNSF_BN1275_V2_A', 'BNSF', now - 30 * 60000)],
    observedTripIds: new Set([tripKey('BNSF_BN1275_V2_B')]),
    now,
    feedHealthy: true,
    keyOf: tripKey,
  });
  assert.strictEqual(inferred.length, 0);
});

// --- station extraction (upstream resolve of friendly names → GTFS) ---

test('extractMetraStations resolves friendly terminal names + roster stops', () => {
  const { extractMetraStations } = require('../../src/metra/metraStations');
  assert.deepStrictEqual(extractMetraStations('arrive Ogilvie Transportation Center at 8:28 PM'), [
    'Chicago OTC',
  ]);
  assert.deepStrictEqual(extractMetraStations('express from Cicero to Chicago Union Station'), [
    'Chicago Union Station',
    'Cicero',
  ]);
  // "Union Station" (friendly) also resolves to the GTFS name.
  assert.deepStrictEqual(extractMetraStations('delays into Union Station'), [
    'Chicago Union Station',
  ]);
  assert.deepStrictEqual(extractMetraStations('no stations here'), []);
});

// --- single-train cancellation classifier (schedule-anchored lifecycle) ---

// Minimal schedule index in the real index.json shape: weekday (WK) service, two
// cancellable trains with real-format trip_ids, and named origin stops.
function cancelIndex() {
  return {
    calendar: {
      WK: {
        days: [true, true, true, true, true, false, false],
        start_date: '20260101',
        end_date: '20261231',
      },
    },
    calendarDates: [],
    stops: {
      OTC: { name: 'Chicago OTC', lat: 41.88, lon: -87.64 },
      GENEVA: { name: 'Geneva', lat: 41.88, lon: -88.31 },
      CUS: { name: 'Chicago Union Station', lat: 41.87, lon: -87.64 },
      FOXLAKE: { name: 'Fox Lake', lat: 42.39, lon: -88.18 },
    },
    trips: {
      // UP-W #67: 20:40 OTC → 22:08 Geneva (the live #67 example).
      'UP-W_UW67_V1_B': {
        route_id: 'UP-W',
        service_id: 'WK',
        headsign: 'Elburn',
        direction_id: 0,
        stop_times: [
          { stop_id: 'OTC', stop_sequence: 1, departure: 74400 }, // 20:40
          { stop_id: 'GENEVA', stop_sequence: 20, arrival: 79680 }, // 22:08
        ],
      },
      // MD-N #2145: 06:30 CUS → 07:45 Fox Lake (informed-entity tripId path).
      'MD-N_MN2145_V2_B': {
        route_id: 'MD-N',
        service_id: 'WK',
        headsign: 'Fox Lake',
        direction_id: 0,
        stop_times: [
          { stop_id: 'CUS', stop_sequence: 1, departure: 23400 }, // 06:30
          { stop_id: 'FOXLAKE', stop_sequence: 18, arrival: 27900 }, // 07:45
        ],
      },
    },
  };
}

// Tuesday 2026-06-09 21:00 America/Chicago (CDT, UTC-5) — same service day as #67.
const CANCEL_NOW = Date.UTC(2026, 5, 10, 2, 0, 0);

function chiHourMin(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

function mkAlert({ header, description = null, routes = [], tripIds = [] }) {
  const informedEntities = [
    ...routes.map((r) => ({ agencyId: null, routeId: r, stopId: null, tripId: null })),
    ...tripIds.map((t) => ({ agencyId: null, routeId: null, stopId: null, tripId: t })),
  ];
  return { id: 'DevAPI-TEST', header, description, informedEntities };
}

test('runNumberFromTripId extracts the run number from a static trip_id', () => {
  assert.strictEqual(runNumberFromTripId('UP-W_UW67_V1_B'), '67');
  assert.strictEqual(runNumberFromTripId('MD-N_MN2145_V2_B'), '2145');
  assert.strictEqual(runNumberFromTripId('SWS_SW823_V4_B'), '823');
  assert.strictEqual(runNumberFromTripId(null), null);
});

test('extractTrainNumbers reads numbers from the header, not the description', () => {
  assert.deepStrictEqual(extractTrainNumbers('UPW train #67 will not operate'), ['67']);
  assert.deepStrictEqual(extractTrainNumbers('MDN 2145 - Will Not Operate'), ['2145']);
  assert.deepStrictEqual(extractTrainNumbers('MED Train #140 Annulled'), ['140']);
  // multi-train notice → both, so the caller declines to finite-track it.
  assert.deepStrictEqual(extractTrainNumbers('Trains #67 and #69 cancelled'), ['67', '69']);
});

test('isCancellationText admits annulment language, rejects delays', () => {
  assert.ok(isCancellationText('UPW train #67 will not operate'));
  assert.ok(isCancellationText('MED Train #140 Annulled'));
  assert.ok(!isCancellationText('BNSF 22 to 27 minutes behind schedule'));
});

test('classify resolves a single-train cancellation from the header (#67)', () => {
  const alert = mkAlert({
    header: 'UPW train #67 will not operate',
    description:
      'UPW train #67 scheduled to depart Ogilvie Transportation Center at 8:40 pm will not operate due to high wind warnings.',
    routes: ['UP-W'],
  });
  const r = classifyCancellationAlert({ alert, index: cancelIndex(), now: CANCEL_NOW });
  assert.ok(r, 'classified');
  assert.strictEqual(r.route, 'UP-W');
  assert.strictEqual(r.trainNumber, '67');
  assert.strictEqual(r.tripId, 'UP-W_UW67_V1_B');
  assert.strictEqual(r.serviceDate, '20260609');
  assert.strictEqual(r.origin, 'Chicago OTC');
  assert.strictEqual(chiHourMin(r.scheduledDepMs), '20:40');
  assert.strictEqual(chiHourMin(r.scheduledArrMs), '22:08');
});

test('classify resolves via the informed-entity tripId when the header has no number', () => {
  const alert = mkAlert({
    header: 'Train Annulled',
    routes: ['MD-N'],
    tripIds: ['MD-N_MN2145_V2_A'], // feed suffix (_A) differs from the static _B
  });
  const r = classifyCancellationAlert({ alert, index: cancelIndex(), now: CANCEL_NOW });
  assert.ok(r, 'classified via tripId');
  assert.strictEqual(r.trainNumber, '2145');
  assert.strictEqual(r.tripId, 'MD-N_MN2145_V2_B'); // resolved to the static variant
  assert.strictEqual(chiHourMin(r.scheduledDepMs), '06:30');
});

test('classify returns null for a delay alert (not a cancellation)', () => {
  const alert = mkAlert({
    header: 'UPW train #67 running 25 minutes late',
    routes: ['UP-W'],
  });
  assert.strictEqual(
    classifyCancellationAlert({ alert, index: cancelIndex(), now: CANCEL_NOW }),
    null,
  );
});

test('classify returns null for an open-ended suspension with no resolvable train', () => {
  const alert = mkAlert({
    header: 'No UP-W inbound service due to police activity',
    routes: ['UP-W'],
  });
  assert.strictEqual(
    classifyCancellationAlert({ alert, index: cancelIndex(), now: CANCEL_NOW }),
    null,
  );
});

test('classify returns null for a multi-train cancellation', () => {
  const alert = mkAlert({
    header: 'UPW trains #67 and #69 will not operate',
    routes: ['UP-W'],
  });
  assert.strictEqual(
    classifyCancellationAlert({ alert, index: cancelIndex(), now: CANCEL_NOW }),
    null,
  );
});

test('classify returns null when the train number does not resolve to a scheduled trip', () => {
  const alert = mkAlert({
    header: 'UPW train #9999 will not operate',
    routes: ['UP-W'],
  });
  assert.strictEqual(
    classifyCancellationAlert({ alert, index: cancelIndex(), now: CANCEL_NOW }),
    null,
  );
});

test('classify returns null when the alert spans more than one route', () => {
  const alert = mkAlert({
    header: 'Train #67 will not operate',
    routes: ['UP-W', 'UP-NW'],
  });
  assert.strictEqual(
    classifyCancellationAlert({ alert, index: cancelIndex(), now: CANCEL_NOW }),
    null,
  );
});
