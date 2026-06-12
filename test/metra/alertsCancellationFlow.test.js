const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

// End-to-end orchestration of bin/metra/alerts.js for single-train cancellations,
// driven against a temp DB with the feed / login / Bluesky boundaries faked via
// the bin's injectable `io` object. Confirms the schedule-anchored lifecycle:
// already-past annulments finalize silently, advance ones go 'upcoming' and get a
// neutral close-note when their departure passes, and the feed-drop "✅ resolved"
// sweep never touches a cancellation.

const BIN = Path.resolve(__dirname, '../../bin/metra/alerts.js');
const HISTORY = Path.resolve(__dirname, '../../src/shared/history.js');
const RUNBIN = Path.resolve(__dirname, '../../src/shared/runBin.js');

// Tuesday 2026-06-09, America/Chicago (CDT).
const T_2100 = Date.UTC(2026, 5, 10, 2, 0, 0); // 9:00 pm — after #67 (8:40), before #678 (11:05)
const T_2310 = Date.UTC(2026, 5, 10, 4, 10, 0); // 11:10 pm — after #678 (11:05)

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
      GENEVA: { name: 'Geneva' },
      BARRINGTON: { name: 'Barrington' },
      HARVARD: { name: 'Harvard' },
    },
    trips: {
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
      'UP-NW_UNW678_V3_B': {
        route_id: 'UP-NW',
        service_id: 'WK',
        headsign: 'Harvard',
        direction_id: 0,
        stop_times: [
          { stop_id: 'BARRINGTON', stop_sequence: 1, departure: 83100 }, // 23:05
          { stop_id: 'HARVARD', stop_sequence: 18, arrival: 86400 }, // 24:00
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

const A67 = alert(
  'a67',
  'UPW train #67 will not operate',
  'Train #67 scheduled to depart Ogilvie at 8:40 pm will not operate.',
  'UP-W',
);
const A678 = alert(
  'a678',
  'UPNW train #678 will not operate',
  'Train #678 scheduled to depart Barrington at 11:05 pm will not operate.',
  'UP-NW',
);

function loadBinWithTempDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-metra-flow-'));
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

test('already-past annulment finalizes silently; advance one stays upcoming', async () => {
  const { bin, history, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([A67, A678]);
    await bin.main({ now: T_2100 });

    // Two alert posts, no replies (no close-note, no "resolved").
    assert.equal(posts.length, 2);
    assert.ok(
      posts.every((p) => p.replyRef == null),
      'no threaded replies yet',
    );
    assert.ok(!posts.some((p) => /resolved/i.test(p.text)), 'never a resolved reply');

    const r67 = history.getAlertPost('a67');
    assert.equal(r67.cancel_state, 'cancelled', '#67 (8:40, already past at 9:00) is finalized');
    assert.ok(r67.resolved_ts != null);
    assert.equal(r67.resolved_reply_uri, null, '#67 finalized silently — no close-note');

    const r678 = history.getAlertPost('a678');
    assert.equal(r678.cancel_state, 'upcoming', '#678 (11:05, future at 9:00) is upcoming');
    assert.equal(r678.resolved_ts, null, 'upcoming is not terminal');
    assert.equal(r678.cancel_origin, 'Barrington');
  } finally {
    cleanup();
  }
});

test('advance cancellation gets a neutral close-note when its departure passes — even with the alert gone from the feed', async () => {
  const { bin, history, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([A678]);
    await bin.main({ now: T_2100 }); // #678 posted, upcoming
    assert.equal(posts.length, 1);
    assert.equal(history.getAlertPost('a678').cancel_state, 'upcoming');

    // Metra pulls the alert from the feed before the train's time (as observed
    // live). The schedule, not the feed, still closes it at 11:05.
    setFeed([]);
    await bin.main({ now: T_2310 });

    const closeNotes = posts.filter((p) => p.replyRef != null);
    assert.equal(closeNotes.length, 1, 'one close-note posted');
    assert.match(closeNotes[0].text, /scheduled departure time has passed/);
    assert.ok(!/resolved/i.test(closeNotes[0].text), 'not a "resolved" reply');
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

    const r678 = history.getAlertPost('a678');
    assert.equal(r678.cancel_state, 'cancelled');
    assert.equal(r678.resolved_ts, r678.cancel_dep_ts, 'closed at the scheduled departure');
    assert.equal(r678.resolved_reply_uri, closeNotes[0].uri);
  } finally {
    cleanup();
  }
});

test('the feed-drop resolution sweep never fires for a cancellation', async () => {
  const { bin, history, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([A678]);
    await bin.main({ now: T_2100 }); // upcoming
    // A non-empty feed that no longer contains the cancellation would normally
    // drive the feed-drop sweep toward a "resolved" reply. It must be skipped.
    setFeed([alert('other', 'Signal problems near Clybourn', 'Expect delays.', 'UP-N')]);
    await bin.main({ now: T_2100 }); // still before #678 departure
    await bin.main({ now: T_2100 });
    await bin.main({ now: T_2100 });

    assert.ok(
      !posts.some((p) => /resolved/i.test(p.text)),
      'no resolved reply for the cancellation',
    );
    assert.equal(
      history.getAlertPost('a678').cancel_state,
      'upcoming',
      'still upcoming, untouched by feed-drop',
    );
    assert.equal(history.getAlertPost('a678').clear_ticks, 0, 'no clear-ticks accrued');
  } finally {
    cleanup();
  }
});
