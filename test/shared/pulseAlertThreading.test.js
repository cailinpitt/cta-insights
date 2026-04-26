const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-pulsethread-'));
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
      } catch (_) {
        /* ignore */
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    },
  };
}

test('getRecentPulsePost returns the most recent posted observed pulse', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'Belmont',
        toStation: 'Howard',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/old',
      },
      t0,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'Belmont',
        toStation: 'Howard',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/new',
      },
      t0 + 60_000,
    );
    const found = history.getRecentPulsePost({ kind: 'train', line: 'red' }, t0 + 120_000);
    assert.equal(found.post_uri, 'at://x/y/new');
    assert.equal(found.from_station, 'Belmont');
  } finally {
    cleanup();
  }
});

test('getRecentPulsePost filters out non-posted, non-observed, and out-of-window rows', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'A',
        toStation: 'B',
        source: 'observed',
        posted: false,
        postUri: null,
      },
      t0,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'A',
        toStation: 'B',
        source: 'cta-alert',
        posted: true,
        postUri: 'at://x/y/cta',
      },
      t0 + 1000,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'A',
        toStation: 'B',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/old',
      },
      t0,
    );
    // Lookup window starts 1 minute before "now" — older row falls outside.
    const found = history.getRecentPulsePost(
      { kind: 'train', line: 'red', withinMs: 60_000 },
      t0 + 120_000,
    );
    assert.equal(found, null);
  } finally {
    cleanup();
  }
});

test('getRecentPulsePost respects direction filter when provided', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'N',
        fromStation: 'A',
        toStation: 'B',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/north',
      },
      t0,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'red',
        direction: 'S',
        fromStation: 'C',
        toStation: 'D',
        source: 'observed',
        posted: true,
        postUri: 'at://x/y/south',
      },
      t0 + 10,
    );
    const north = history.getRecentPulsePost(
      { kind: 'train', line: 'red', direction: 'N' },
      t0 + 1000,
    );
    assert.equal(north.post_uri, 'at://x/y/north');
    const south = history.getRecentPulsePost(
      { kind: 'train', line: 'red', direction: 'S' },
      t0 + 1000,
    );
    assert.equal(south.post_uri, 'at://x/y/south');
  } finally {
    cleanup();
  }
});

test('hasUnresolvedCtaAlert matches comma-bracketed route codes without false positives', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'Red,P',
      headline: 'h',
      postUri: 'at://x/y/a1',
    });
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Red' }), true);
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'P' }), true);
    // 'Re' must not match 'Red' via substring — comma boundary protects it.
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Re' }), false);
    // Resolved alerts no longer count as open.
    history.recordAlertResolved({ alertId: 'a1', replyUri: 'at://reply' });
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Red' }), false);
  } finally {
    cleanup();
  }
});

test('hasUnresolvedCtaAlert ignores rows that have not been posted yet', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'Red',
      headline: 'h',
      postUri: null,
    });
    assert.equal(history.hasUnresolvedCtaAlert({ kind: 'train', ctaRouteCode: 'Red' }), false);
  } finally {
    cleanup();
  }
});
