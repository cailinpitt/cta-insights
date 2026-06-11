const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyDelayAlert,
  parseMaxDelayMinutes,
  trainNumbersFromText,
  DELAY_RESOLVE_GRACE_MS,
} = require('../../src/metra/delayAlert');

// Tuesday 2026-06-09, America/Chicago (CDT = UTC-5). UW31 arrives Elburn 13:08.
const NOW = Date.UTC(2026, 5, 9, 18, 0, 0); // 1:00 pm

function index() {
  return {
    calendar: {
      WK: {
        days: [true, true, true, true, true, false, false],
        start_date: '20260101',
        end_date: '20261231',
      },
    },
    calendarDates: [],
    stops: { OTC: { name: 'Chicago OTC' }, ELBURN: { name: 'Elburn' } },
    trips: {
      'UP-W_UW31_V1_B': {
        route_id: 'UP-W',
        service_id: 'WK',
        headsign: 'Elburn',
        direction_id: 0,
        stop_times: [
          { stop_id: 'OTC', stop_sequence: 1, departure: 43200 }, // 12:00
          { stop_id: 'ELBURN', stop_sequence: 18, arrival: 47280 }, // 13:08
        ],
      },
    },
  };
}

function alert(header, description, route = 'UP-W', tripId = null) {
  return { id: 'x', header, description, informedEntities: [{ routeId: route, tripId }] };
}

test('parseMaxDelayMinutes takes the upper bound of a range', () => {
  assert.equal(parseMaxDelayMinutes('operating 25 to 35 minutes behind schedule'), 35);
  assert.equal(parseMaxDelayMinutes('15 to 20 minutes behind schedule'), 20);
  assert.equal(parseMaxDelayMinutes('20 minutes late'), 20);
  assert.equal(parseMaxDelayMinutes('20+ minutes late'), 20);
  assert.equal(parseMaxDelayMinutes('20 or more minutes late'), 20);
  assert.equal(parseMaxDelayMinutes('a 10 minute delay'), 10);
  assert.equal(parseMaxDelayMinutes('minor delays expected'), null);
  assert.equal(parseMaxDelayMinutes(''), null);
});

test('trainNumbersFromText reads only numbers anchored to "train"', () => {
  // Magnitudes and clock times must NOT be read as train numbers.
  assert.deepEqual(
    trainNumbersFromText(
      'Train 31, scheduled to arrive Elburn at 1:08 p.m., operating 25 to 35 minutes behind',
    ),
    ['31'],
  );
  assert.deepEqual(trainNumbersFromText('UPW train #50 scheduled to arrive Ogilvie'), ['50']);
  assert.deepEqual(trainNumbersFromText('Expect 20 minute delays system-wide'), []);
});

test('classifyDelayAlert anchors a single-train delay to the schedule', () => {
  const a = alert(
    'UPW 31 On The Move',
    'Train 31, scheduled to arrive Elburn at 1:08 p.m., is on the move and operating 25 to 35 minutes behind schedule due to a vehicle stuck on the tracks.',
  );
  const d = classifyDelayAlert({ alert: a, index: index(), now: NOW });
  assert.ok(d, 'classifies');
  assert.equal(d.route, 'UP-W');
  assert.equal(d.trainNumber, '31');
  assert.equal(d.maxDelayMin, 35);
  assert.equal(d.scheduledArrMs, Date.UTC(2026, 5, 9, 18, 8, 0), '13:08 CDT');
  assert.equal(d.deadlineMs, d.scheduledArrMs + 35 * 60000 + DELAY_RESOLVE_GRACE_MS);
});

test('classifyDelayAlert prefers the informed-entity trip run number', () => {
  const a = alert('UPW delay', 'A train is operating 30 minutes late.', 'UP-W', 'UP-W_UW31_V2_A');
  const d = classifyDelayAlert({ alert: a, index: index(), now: NOW });
  assert.ok(d);
  assert.equal(d.trainNumber, '31');
  assert.equal(d.maxDelayMin, 30);
});

test('classifyDelayAlert returns null for non-delay, cancellation, multi/zero-train, or unresolvable', () => {
  const idx = index();
  // No magnitude.
  assert.equal(
    classifyDelayAlert({ alert: alert('UPW', 'Minor delays expected.'), index: idx, now: NOW }),
    null,
  );
  // Cancellation owns its own path even with a magnitude-shaped phrase.
  assert.equal(
    classifyDelayAlert({
      alert: alert('UPW 31', 'Train 31 will not operate; 20 minutes late trains elsewhere.'),
      index: idx,
      now: NOW,
    }),
    null,
  );
  // No resolvable single train (magnitude only, system-wide).
  assert.equal(
    classifyDelayAlert({
      alert: alert('UPW', 'Expect 20 minutes late service.'),
      index: idx,
      now: NOW,
    }),
    null,
  );
  // Train number that doesn't resolve to a scheduled trip.
  assert.equal(
    classifyDelayAlert({
      alert: alert('UPW 999', 'Train 999 operating 20 minutes late.'),
      index: idx,
      now: NOW,
    }),
    null,
  );
});
