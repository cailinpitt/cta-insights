const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');
const Database = require('better-sqlite3');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-related-quotes-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    dbPath,
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_e) {
        /* ignore */
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

test('alert_posts schema includes affected_* columns on fresh DB', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const cols = history
      .getDb()
      .prepare('PRAGMA table_info(alert_posts)')
      .all()
      .map((c) => c.name);
    for (const name of ['affected_from_station', 'affected_to_station', 'affected_direction']) {
      assert.ok(cols.includes(name), `missing column: ${name}`);
    }
  } finally {
    cleanup();
  }
});

test('bus_pulse_state schema includes affected_pid/lo/hi on fresh DB', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const cols = history
      .getDb()
      .prepare('PRAGMA table_info(bus_pulse_state)')
      .all()
      .map((c) => c.name);
    for (const name of ['affected_pid', 'affected_lo_ft', 'affected_hi_ft']) {
      assert.ok(cols.includes(name), `missing column: ${name}`);
    }
  } finally {
    cleanup();
  }
});

test('thread_quote_posts table exists on fresh DB', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const cols = history
      .getDb()
      .prepare('PRAGMA table_info(thread_quote_posts)')
      .all()
      .map((c) => c.name);
    for (const name of ['thread_root_uri', 'source_post_uri', 'quote_post_uri', 'ts']) {
      assert.ok(cols.includes(name), `missing column: ${name}`);
    }
  } finally {
    cleanup();
  }
});

test('migration: opening pre-existing DB without new columns adds them', () => {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-migration-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  // Create a legacy schema explicitly missing the new columns/tables.
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE alert_posts (
      alert_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      routes TEXT,
      headline TEXT,
      first_seen_ts INTEGER NOT NULL,
      last_seen_ts INTEGER NOT NULL,
      post_uri TEXT,
      resolved_ts INTEGER,
      resolved_reply_uri TEXT
    );
    CREATE TABLE bus_pulse_state (
      route TEXT PRIMARY KEY,
      started_ts INTEGER,
      last_seen_ts INTEGER,
      consecutive_ticks INTEGER NOT NULL DEFAULT 0,
      clear_ticks INTEGER NOT NULL DEFAULT 0,
      posted_cooldown_key TEXT
    );
  `);
  legacy.close();

  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  try {
    history.getDb();
    const alertCols = history
      .getDb()
      .prepare('PRAGMA table_info(alert_posts)')
      .all()
      .map((c) => c.name);
    assert.ok(alertCols.includes('affected_from_station'));
    assert.ok(alertCols.includes('affected_to_station'));
    assert.ok(alertCols.includes('affected_direction'));
    const busCols = history
      .getDb()
      .prepare('PRAGMA table_info(bus_pulse_state)')
      .all()
      .map((c) => c.name);
    assert.ok(busCols.includes('affected_pid'));
    assert.ok(busCols.includes('affected_lo_ft'));
    assert.ok(busCols.includes('affected_hi_ft'));
    // thread_quote_posts created via CREATE TABLE IF NOT EXISTS
    const tqCols = history.getDb().prepare('PRAGMA table_info(thread_quote_posts)').all();
    assert.ok(tqCols.length > 0);
  } finally {
    try {
      history.getDb().close();
    } catch (_e) {
      /* ignore */
    }
    delete require.cache[require.resolve('../../src/shared/history')];
    delete process.env.HISTORY_DB_PATH;
    Fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordAlertSeen round-trips affected_* fields and preserves on re-tick', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const now = Date.now();
    history.recordAlertSeen(
      {
        alertId: 'a1',
        kind: 'train',
        routes: 'Red',
        headline: 'Red Line delay',
        postUri: 'at://post-1',
        affectedFromStation: 'Belmont',
        affectedToStation: 'Fullerton',
        affectedDirection: 'Northbound',
      },
      now,
    );
    let row = history.getAlertPost('a1');
    assert.equal(row.affected_from_station, 'Belmont');
    assert.equal(row.affected_to_station, 'Fullerton');
    assert.equal(row.affected_direction, 'Northbound');

    // Second tick lacks affected_*; must not clobber.
    history.recordAlertSeen(
      { alertId: 'a1', kind: 'train', routes: 'Red', headline: 'Red Line delay updated' },
      now + 1000,
    );
    row = history.getAlertPost('a1');
    assert.equal(row.affected_from_station, 'Belmont');
    assert.equal(row.affected_to_station, 'Fullerton');
    assert.equal(row.affected_direction, 'Northbound');
    assert.equal(row.headline, 'Red Line delay updated');

    // A non-null value replaces.
    history.recordAlertSeen(
      {
        alertId: 'a1',
        kind: 'train',
        routes: 'Red',
        affectedFromStation: 'Addison',
      },
      now + 2000,
    );
    row = history.getAlertPost('a1');
    assert.equal(row.affected_from_station, 'Addison');
    assert.equal(row.affected_to_station, 'Fullerton');
  } finally {
    cleanup();
  }
});

test('upsertBusPulseState round-trips affected_pid/lo/hi and preserves on re-tick', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const now = Date.now();
    history.upsertBusPulseState({
      route: '66',
      startedTs: now,
      lastSeenTs: now,
      consecutiveTicks: 1,
      clearTicks: 0,
      postedCooldownKey: 'bus_pulse_66',
      affectedPid: 'pid-66-east',
      affectedLoFt: 1234,
      affectedHiFt: 5678,
    });
    let row = history.getBusPulseState('66');
    assert.equal(row.affected_pid, 'pid-66-east');
    assert.equal(row.affected_lo_ft, 1234);
    assert.equal(row.affected_hi_ft, 5678);

    // Second tick without affected_* -> preserve.
    history.upsertBusPulseState({
      route: '66',
      startedTs: now,
      lastSeenTs: now + 5000,
      consecutiveTicks: 2,
      clearTicks: 0,
      postedCooldownKey: 'bus_pulse_66',
    });
    row = history.getBusPulseState('66');
    assert.equal(row.affected_pid, 'pid-66-east');
    assert.equal(row.affected_lo_ft, 1234);
    assert.equal(row.affected_hi_ft, 5678);
    assert.equal(row.consecutive_ticks, 2);

    // Non-null replaces.
    history.upsertBusPulseState({
      route: '66',
      startedTs: now,
      lastSeenTs: now + 10000,
      consecutiveTicks: 3,
      clearTicks: 0,
      postedCooldownKey: 'bus_pulse_66',
      affectedLoFt: 2000,
    });
    row = history.getBusPulseState('66');
    assert.equal(row.affected_pid, 'pid-66-east');
    assert.equal(row.affected_lo_ft, 2000);
    assert.equal(row.affected_hi_ft, 5678);
  } finally {
    cleanup();
  }
});

test('recordThreadQuote + getThreadQuotedSourceUris round-trip; null quote uri tombstone', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const root = 'at://root-1';
    history.recordThreadQuote({
      threadRootUri: root,
      sourcePostUri: 'at://src-1',
      quotePostUri: 'at://quote-1',
    });
    history.recordThreadQuote({
      threadRootUri: root,
      sourcePostUri: 'at://src-2',
      quotePostUri: null,
    });
    history.recordThreadQuote({
      threadRootUri: 'at://other-root',
      sourcePostUri: 'at://src-3',
      quotePostUri: 'at://quote-3',
    });

    const set = history.getThreadQuotedSourceUris(root);
    assert.ok(set instanceof Set);
    assert.equal(set.size, 2);
    assert.ok(set.has('at://src-1'));
    assert.ok(set.has('at://src-2'));
    assert.ok(!set.has('at://src-3'));

    // INSERT OR REPLACE: re-record with a real uri updates row but key still in set.
    history.recordThreadQuote({
      threadRootUri: root,
      sourcePostUri: 'at://src-2',
      quotePostUri: 'at://quote-2',
    });
    const set2 = history.getThreadQuotedSourceUris(root);
    assert.equal(set2.size, 2);
    assert.ok(set2.has('at://src-2'));
    const row = history
      .getDb()
      .prepare(
        'SELECT quote_post_uri FROM thread_quote_posts WHERE thread_root_uri = ? AND source_post_uri = ?',
      )
      .get(root, 'at://src-2');
    assert.equal(row.quote_post_uri, 'at://quote-2');
  } finally {
    cleanup();
  }
});

test('findRelatedAnalyticsPosts: filters route, time, posted, post_uri, exclude', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const now = 1_700_000_000_000;
    // bunching events
    history.recordBunching(
      {
        kind: 'bus',
        route: '66',
        direction: 'East',
        vehicleCount: 3,
        severityFt: 500,
        nearStop: 'Clark',
        posted: 1,
        postUri: 'at://b-1',
      },
      now - 60_000,
    );
    history.recordBunching(
      {
        kind: 'bus',
        route: '66',
        direction: 'East',
        vehicleCount: 3,
        severityFt: 500,
        nearStop: 'Clark',
        posted: 0, // not posted
        postUri: null,
      },
      now - 50_000,
    );
    history.recordBunching(
      {
        kind: 'bus',
        route: '66',
        direction: 'East',
        vehicleCount: 3,
        severityFt: 500,
        nearStop: 'Clark',
        posted: 1,
        postUri: null, // posted but no uri
      },
      now - 40_000,
    );
    history.recordBunching(
      {
        kind: 'bus',
        route: '79', // different route
        direction: 'West',
        vehicleCount: 2,
        severityFt: 400,
        nearStop: 'Halsted',
        posted: 1,
        postUri: 'at://b-other',
      },
      now - 30_000,
    );
    history.recordBunching(
      {
        kind: 'train', // different kind
        route: 'Red',
        direction: 'NB',
        vehicleCount: 2,
        severityFt: 400,
        nearStop: 'Belmont',
        posted: 1,
        postUri: 'at://b-train',
      },
      now - 20_000,
    );
    // gap events
    history.recordGap(
      {
        kind: 'bus',
        route: '66',
        direction: 'East',
        gapFt: 5000,
        gapMin: 10,
        expectedMin: 5,
        ratio: 2,
        nearStop: 'Clark',
        posted: 1,
        postUri: 'at://g-1',
      },
      now - 10_000,
    );
    history.recordGap(
      {
        kind: 'bus',
        route: '66',
        direction: 'East',
        gapFt: 5000,
        gapMin: 10,
        expectedMin: 5,
        ratio: 2,
        nearStop: 'Clark',
        posted: 1,
        postUri: 'at://g-excluded',
      },
      now - 5_000,
    );
    // out-of-window event
    history.recordGap(
      {
        kind: 'bus',
        route: '66',
        direction: 'East',
        gapFt: 5000,
        gapMin: 10,
        expectedMin: 5,
        ratio: 2,
        nearStop: 'Clark',
        posted: 1,
        postUri: 'at://g-old',
      },
      now - 10_000_000,
    );

    const results = history.findRelatedAnalyticsPosts({
      kind: 'bus',
      routes: ['66'],
      sinceTs: now - 120_000,
      untilTs: now,
      excludeSourceUris: ['at://g-excluded'],
    });

    const uris = results.map((r) => r.post_uri);
    assert.deepEqual(uris.sort(), ['at://b-1', 'at://g-1'].sort());
    // sorted ts DESC
    assert.ok(results[0].ts >= results[results.length - 1].ts);
    const bunch = results.find((r) => r.source === 'bunching');
    const gap = results.find((r) => r.source === 'gap');
    assert.equal(bunch.route, '66');
    assert.equal(bunch.direction, 'East');
    assert.equal(bunch.near_stop, 'Clark');
    assert.equal(bunch.raw.vehicle_count, 3);
    assert.equal(gap.raw.gap_min, 10);

    // empty routes -> empty
    assert.deepEqual(
      history.findRelatedAnalyticsPosts({
        kind: 'bus',
        routes: [],
        sinceTs: 0,
        untilTs: now,
      }),
      [],
    );

    // exclude as Set works
    const excludedSet = history.findRelatedAnalyticsPosts({
      kind: 'bus',
      routes: ['66'],
      sinceTs: now - 120_000,
      untilTs: now,
      excludeSourceUris: new Set(['at://b-1', 'at://g-1', 'at://g-excluded']),
    });
    assert.equal(excludedSet.length, 0);
  } finally {
    cleanup();
  }
});
