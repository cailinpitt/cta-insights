const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

// End-to-end orchestration of bin/metra/alerts.js for single-train DELAYS, driven
// against a temp DB with the feed / login / Bluesky boundaries faked via the bin's
// injectable `io`. Confirms the schedule-anchored delay lifecycle: a qualified
// delay posts and gets a deadline (final scheduled arrival + announced delay +
// grace); past that deadline it gets a NEUTRAL close-note and resolves — even while
// still on the feed; a worsening delay pushes the deadline out; and if Metra drops
// it before the deadline, the ordinary feed-drop "✅ resolved" sweep still fires.

const BIN = Path.resolve(__dirname, '../../bin/metra/alerts.js');
const HISTORY = Path.resolve(__dirname, '../../src/shared/history.js');
const RUNBIN = Path.resolve(__dirname, '../../src/shared/runBin.js');

// Tuesday 2026-06-09, America/Chicago (CDT = UTC-5). Train #31 arrives Elburn 13:08.
const T_1300 = Date.UTC(2026, 5, 9, 18, 0, 0); // 1:00 pm — train en route, before deadline (1:58)
const T_1430 = Date.UTC(2026, 5, 9, 19, 30, 0); // 2:30 pm — past the 1:58 deadline

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
    stops: {
      OTC: { name: 'Chicago OTC' },
      ELBURN: { name: 'Elburn' },
    },
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

function alert(id, header, description, route) {
  return {
    id,
    header,
    description,
    informedEntities: [{ agencyId: null, routeId: route, stopId: null, tripId: null }],
  };
}

const A31 = alert(
  'a31',
  'UPW 31 On The Move',
  'Train 31, scheduled to arrive Elburn at 1:08 p.m., is on the move and operating 25 to 35 minutes behind schedule due to a vehicle stuck on the tracks.',
  'UP-W',
);

function loadBinWithTempDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-metra-delay-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete process.env.METRA_DRY_RUN;
  for (const m of [HISTORY, RUNBIN, BIN]) delete require.cache[m];
  const bin = require(BIN);
  const history = require(HISTORY);
  history.getDb();

  const posts = [];
  let feed = [];
  Object.assign(bin.io, {
    getMetraAlerts: async () => feed,
    loadIndex: () => index(),
    loginMetraAlerts: async () => ({ fake: true }),
    postText: async (_agent, text, replyRef) => {
      const uri = `at://did/app.bsky.feed.post/rk${posts.length + 1}`;
      posts.push({ text, replyRef: replyRef || null, uri });
      return { uri, url: `https://bsky.app/${uri}` };
    },
    postTextWithLinkCard: async (_agent, text, replyRef, link) => {
      const uri = `at://did/app.bsky.feed.post/rk${posts.length + 1}`;
      posts.push({ text, replyRef: replyRef || null, uri, link });
      return { uri, url: `https://bsky.app/${uri}` };
    },
    resolveReplyRef: async (_agent, uri) => ({ root: { uri }, parent: { uri } }),
  });

  return {
    bin,
    history,
    posts,
    setFeed: (f) => {
      feed = f;
    },
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_e) {
        /* ignore */
      }
      for (const m of [HISTORY, RUNBIN, BIN]) delete require.cache[m];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

// 1:08 pm + 35 min announced + 15 min grace = 1:58 pm.
const DEADLINE = Date.UTC(2026, 5, 9, 18, 58, 0);

test('qualified delay posts with a schedule-anchored deadline; resolves with a neutral note past it — even still on the feed', async () => {
  const { bin, history, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([A31]);
    await bin.main({ now: T_1300 });

    assert.equal(posts.length, 1, 'one alert post');
    assert.equal(posts[0].replyRef, null, 'no reply yet');
    const r = history.getAlertPost('a31');
    assert.equal(r.delay_deadline_ts, DEADLINE, 'deadline = arrival + 35m + 15m grace');
    assert.equal(r.delay_min, 35, 'max of the 25–35 range');
    assert.equal(r.delay_train_no, '31');
    assert.equal(r.resolved_ts, null, 'not resolved before the deadline');

    // Metra still shows the delay (same feed), but we're past the deadline.
    await bin.main({ now: T_1430 });

    const closeNotes = posts.filter((p) => p.replyRef != null);
    assert.equal(closeNotes.length, 1, 'one close-note');
    assert.match(closeNotes[0].text, /should have reached its destination/);
    assert.ok(!/resolved/i.test(closeNotes[0].text), 'NOT a "resolved" reply');
    // ...but it links to the incident's archive page, with a neutral card title.
    assert.ok(closeNotes[0].link, 'close-note carries an archive link card');
    assert.match(
      closeNotes[0].link.url,
      /\/event\/rk1\/resolved$/,
      'links to the incident archive',
    );
    assert.doesNotMatch(
      closeNotes[0].link.title,
      /reports this is resolved/i,
      'neutral card title',
    );

    const r2 = history.getAlertPost('a31');
    assert.equal(r2.resolved_ts, DEADLINE, 'resolved at the deadline, not "now"');
    assert.equal(r2.resolved_reply_uri, closeNotes[0].uri);
    assert.equal(r2.clear_ticks, 0, 'never went through the feed-drop tick path');

    // Metra may keep the same delay alert on the wire after our schedule-based
    // terminal close. A later sighting must not reopen the row and post another
    // close-note every cron tick.
    await bin.main({ now: T_1430 + 2 * 60_000 });
    assert.equal(
      posts.filter((p) => p.replyRef != null).length,
      1,
      'no duplicate close-note after the schedule-terminal resolution',
    );
    assert.equal(history.getAlertPost('a31').resolved_ts, DEADLINE, 'stays resolved');
  } finally {
    cleanup();
  }
});

test('a worsening delay pushes the deadline out', async () => {
  const { bin, history, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([A31]);
    await bin.main({ now: T_1300 });
    assert.equal(history.getAlertPost('a31').delay_deadline_ts, DEADLINE);

    // Metra updates the same alert: now 45–55 minutes behind. Re-sight pushes the
    // deadline to 1:08 + 55 + 15 = 2:18 pm.
    const worse = alert(
      'a31',
      'UPW 31 On The Move',
      'Train 31, scheduled to arrive Elburn at 1:08 p.m., is operating 45 to 55 minutes behind schedule.',
      'UP-W',
    );
    setFeed([worse]);
    await bin.main({ now: T_1300 });

    const r = history.getAlertPost('a31');
    assert.equal(r.delay_deadline_ts, Date.UTC(2026, 5, 9, 19, 18, 0), 'deadline moved out');
    assert.equal(r.delay_min, 35, 'first announced magnitude kept for display (COALESCE)');

    // 2:30 pm is past even the pushed deadline → now it resolves.
    await bin.main({ now: T_1430 });
    assert.equal(history.getAlertPost('a31').resolved_ts != null, true);
  } finally {
    cleanup();
  }
});

test('if Metra clears the delay before the deadline, the ordinary feed-drop resolution still fires', async () => {
  const { bin, history, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([A31]);
    await bin.main({ now: T_1300 });
    assert.equal(history.getAlertPost('a31').resolved_ts, null);

    // Metra drops the delay from the feed (a real clear) before our deadline. A
    // non-empty feed drives the feed-drop sweep across ALERT_CLEAR_TICKS ticks.
    const other = alert(
      'other',
      'Signal problems near Clybourn',
      'Expect 10 minute delays.',
      'UP-N',
    );
    setFeed([other]);
    await bin.main({ now: T_1300 });
    await bin.main({ now: T_1300 });
    await bin.main({ now: T_1300 });

    const resolved = posts.filter((p) => p.replyRef != null);
    assert.equal(resolved.length, 1, 'one feed-drop resolution reply');
    assert.match(
      resolved[0].text,
      /resolved/i,
      'feed-drop path DOES say resolved (Metra cleared it)',
    );
    assert.equal(history.getAlertPost('a31').resolved_ts != null, true);
  } finally {
    cleanup();
  }
});
