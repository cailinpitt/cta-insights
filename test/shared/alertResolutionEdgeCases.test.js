const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-alert-edge-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
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

test('Bug 20: recordAlertSeen clears resolved_ts when post_uri arrives late', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen({
      alertId: 'A',
      kind: 'train',
      routes: 'y',
      headline: 'x',
      postUri: null,
    });
    history.recordAlertResolved({ alertId: 'A', replyUri: null });
    let row = history.getAlertPost('A');
    assert.notEqual(row.resolved_ts, null);
    assert.equal(row.post_uri, null);

    history.recordAlertSeen({
      alertId: 'A',
      kind: 'train',
      routes: 'y',
      headline: 'x',
      postUri: 'at://x/y/z',
    });
    row = history.getAlertPost('A');
    assert.equal(row.post_uri, 'at://x/y/z');
    assert.equal(row.resolved_ts, null);
    assert.equal(row.resolved_reply_uri, null);
    assert.equal(row.clear_ticks, 0);
  } finally {
    cleanup();
  }
});

test('Bug 22: resolved alert re-published after flicker gap re-engages', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = Date.now() - 60 * 60 * 1000; // 1h ago
    history.recordAlertSeen(
      { alertId: 'B', kind: 'train', routes: 'y', headline: 'h', postUri: 'at://orig' },
      t0,
    );
    history.recordAlertResolved({ alertId: 'B', replyUri: 'at://reply' }, t0 + 1000);

    // CTA re-publishes the same alert id much later — should re-engage tracking.
    history.recordAlertSeen({
      alertId: 'B',
      kind: 'train',
      routes: 'y',
      headline: 'h',
      postUri: null,
    });
    const row = history.getAlertPost('B');
    assert.equal(row.resolved_ts, null);
    assert.equal(row.resolved_reply_uri, null);
    assert.equal(row.clear_ticks, 0);
  } finally {
    cleanup();
  }
});

test('recordAlertSeen does not touch resolved_ts on normal subsequent ticks', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = Date.now();
    history.recordAlertSeen(
      { alertId: 'C', kind: 'train', routes: 'y', headline: 'h', postUri: 'at://c' },
      t0,
    );
    // Refresh on next tick — resolved_ts should remain null and stay null.
    history.recordAlertSeen(
      { alertId: 'C', kind: 'train', routes: 'y', headline: 'h', postUri: null },
      t0 + 60_000,
    );
    const row = history.getAlertPost('C');
    assert.equal(row.resolved_ts, null);
    assert.equal(row.post_uri, 'at://c');
  } finally {
    cleanup();
  }
});

test('hasUnresolvedCtaAlert finds an open alert regardless of when it started', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const tFar = Date.now() - 6 * 60 * 60 * 1000;
    history.recordAlertSeen(
      { alertId: 'D', kind: 'train', routes: 'y', headline: 'h', postUri: 'at://d' },
      tFar,
    );
    assert.ok(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Y' }));
    history.recordAlertResolved({ alertId: 'D', replyUri: 'at://reply' });
    assert.ok(!history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Y' }));
  } finally {
    cleanup();
  }
});

test('rolloffOld deletes expired and ancient cooldowns', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const db = history.getDb();
    const now = Date.now();
    const ancient = now - 100 * 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO cooldowns (key, ts, expires_at) VALUES (?, ?, ?)').run(
      'expired',
      now - 1000,
      now - 500,
    );
    db.prepare('INSERT INTO cooldowns (key, ts, expires_at) VALUES (?, ?, ?)').run(
      'active',
      now,
      now + 60_000,
    );
    db.prepare('INSERT INTO cooldowns (key, ts, expires_at) VALUES (?, ?, ?)').run(
      'legacy-ancient',
      ancient,
      null,
    );
    history.rolloffOld(now);
    const remaining = db
      .prepare('SELECT key FROM cooldowns ORDER BY key')
      .all()
      .map((r) => r.key);
    assert.deepEqual(remaining, ['active']);
  } finally {
    cleanup();
  }
});

test('hasObservedClearForPulse: targets exact pulse uri', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = Date.now() - 60_000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'y',
        direction: 'all',
        fromStation: 'Howard',
        toStation: 'Dempster-Skokie',
        source: 'observed',
        posted: true,
        postUri: 'at://pulse-1',
      },
      t0,
    );
    assert.equal(
      history.hasObservedClearForPulse({ kind: 'train', pulseUri: 'at://pulse-1' }),
      false,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'y',
        direction: 'all',
        fromStation: 'Howard',
        toStation: 'Dempster-Skokie',
        source: 'observed-clear',
        posted: true,
        postUri: 'at://clear-1',
      },
      t0 + 60_000,
    );
    assert.equal(
      history.hasObservedClearForPulse({ kind: 'train', pulseUri: 'at://pulse-1' }),
      true,
    );
    assert.equal(
      history.hasObservedClearForPulse({ kind: 'train', pulseUri: 'at://nonexistent' }),
      false,
    );
  } finally {
    cleanup();
  }
});

test('hasObservedClearForPulse: clears on other lines/directions do not shadow this pulse', () => {
  // Real-world false skip on 2026-05-02: an Orange inbound clear posted at
  // 15:40 made the Brown inbound clear at 15:13 appear "already posted" and
  // got skipped, leaving the Brown pulse without a ✅ reply.
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = Date.now() - 60_000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'brn',
        direction: 'branch-1-inbound',
        fromStation: 'Washington/Wells',
        toStation: 'Harold Washington Library-State/Van Buren',
        source: 'observed',
        posted: true,
        postUri: 'at://brn-pulse',
      },
      t0,
    );
    // Unrelated Orange clear posted AFTER the Brown pulse — must not be
    // treated as a clear for the Brown pulse.
    history.recordDisruption(
      {
        kind: 'train',
        line: 'org',
        direction: 'branch-1-inbound',
        fromStation: 'Roosevelt',
        toStation: 'Washington/Wabash',
        source: 'observed-clear',
        posted: true,
        postUri: 'at://org-clear',
      },
      t0 + 30_000,
    );
    assert.equal(
      history.hasObservedClearForPulse({ kind: 'train', pulseUri: 'at://brn-pulse' }),
      false,
    );
    // Now record the matching Brown clear — should flip to true.
    history.recordDisruption(
      {
        kind: 'train',
        line: 'brn',
        direction: 'branch-1-inbound',
        fromStation: 'Washington/Wells',
        toStation: 'Harold Washington Library-State/Van Buren',
        source: 'observed-clear',
        posted: true,
        postUri: 'at://brn-clear',
      },
      t0 + 60_000,
    );
    assert.equal(
      history.hasObservedClearForPulse({ kind: 'train', pulseUri: 'at://brn-pulse' }),
      true,
    );
  } finally {
    cleanup();
  }
});
