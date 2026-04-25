const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('path');
const Fs = require('fs');
const Os = require('os');

function freshDbPath() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-pulsethread-'));
  return Path.join(dir, 'history.sqlite');
}

// Mirror of test/shared/alertsResolution.test.js — swap state/history.sqlite
// for a fresh DB, then restore after the test.
function loadHistoryWithDb() {
  const repoState = Path.join(__dirname, '..', '..', 'state');
  const real = Path.join(repoState, 'history.sqlite');
  const realWal = `${real}-wal`;
  const realShm = `${real}-shm`;
  const backup = Fs.existsSync(real) ? Fs.readFileSync(real) : null;
  const backupWal = Fs.existsSync(realWal) ? Fs.readFileSync(realWal) : null;
  const backupShm = Fs.existsSync(realShm) ? Fs.readFileSync(realShm) : null;
  if (Fs.existsSync(real)) Fs.unlinkSync(real);
  if (Fs.existsSync(realWal)) Fs.unlinkSync(realWal);
  if (Fs.existsSync(realShm)) Fs.unlinkSync(realShm);

  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();

  return {
    history,
    cleanup: () => {
      try { history.getDb().close(); } catch (_) { /* ignore */ }
      delete require.cache[require.resolve('../../src/shared/history')];
      if (Fs.existsSync(real)) Fs.unlinkSync(real);
      if (Fs.existsSync(realWal)) Fs.unlinkSync(realWal);
      if (Fs.existsSync(realShm)) Fs.unlinkSync(realShm);
      if (backup) Fs.writeFileSync(real, backup);
      if (backupWal) Fs.writeFileSync(realWal, backupWal);
      if (backupShm) Fs.writeFileSync(realShm, backupShm);
    },
  };
}

test('getRecentPulsePost returns the most recent posted observed pulse', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption({
      kind: 'train', line: 'red', direction: 'N',
      fromStation: 'Belmont', toStation: 'Howard',
      source: 'observed', posted: true, postUri: 'at://x/y/old',
    }, t0);
    history.recordDisruption({
      kind: 'train', line: 'red', direction: 'N',
      fromStation: 'Belmont', toStation: 'Howard',
      source: 'observed', posted: true, postUri: 'at://x/y/new',
    }, t0 + 60_000);
    const found = history.getRecentPulsePost({ kind: 'train', line: 'red' }, t0 + 120_000);
    assert.equal(found.post_uri, 'at://x/y/new');
    assert.equal(found.from_station, 'Belmont');
  } finally { cleanup(); }
});

test('getRecentPulsePost filters out non-posted, non-observed, and out-of-window rows', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption({
      kind: 'train', line: 'red', direction: 'N',
      fromStation: 'A', toStation: 'B',
      source: 'observed', posted: false, postUri: null,
    }, t0);
    history.recordDisruption({
      kind: 'train', line: 'red', direction: 'N',
      fromStation: 'A', toStation: 'B',
      source: 'cta-alert', posted: true, postUri: 'at://x/y/cta',
    }, t0 + 1000);
    history.recordDisruption({
      kind: 'train', line: 'red', direction: 'N',
      fromStation: 'A', toStation: 'B',
      source: 'observed', posted: true, postUri: 'at://x/y/old',
    }, t0);
    // Lookup window starts 1 minute before "now" — older row falls outside.
    const found = history.getRecentPulsePost(
      { kind: 'train', line: 'red', withinMs: 60_000 },
      t0 + 120_000,
    );
    assert.equal(found, null);
  } finally { cleanup(); }
});

test('getRecentPulsePost respects direction filter when provided', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordDisruption({
      kind: 'train', line: 'red', direction: 'N',
      fromStation: 'A', toStation: 'B',
      source: 'observed', posted: true, postUri: 'at://x/y/north',
    }, t0);
    history.recordDisruption({
      kind: 'train', line: 'red', direction: 'S',
      fromStation: 'C', toStation: 'D',
      source: 'observed', posted: true, postUri: 'at://x/y/south',
    }, t0 + 10);
    const north = history.getRecentPulsePost({ kind: 'train', line: 'red', direction: 'N' }, t0 + 1000);
    assert.equal(north.post_uri, 'at://x/y/north');
    const south = history.getRecentPulsePost({ kind: 'train', line: 'red', direction: 'S' }, t0 + 1000);
    assert.equal(south.post_uri, 'at://x/y/south');
  } finally { cleanup(); }
});

test('hasObservedClearSince returns true only after a clear is recorded', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    assert.equal(
      history.hasObservedClearSince({ kind: 'train', line: 'red', direction: 'N', sinceTs: t0 }),
      false,
    );
    history.recordDisruption({
      kind: 'train', line: 'red', direction: 'N',
      fromStation: 'A', toStation: 'B',
      source: 'observed-clear', posted: true, postUri: 'at://x/y/clear',
    }, t0 + 1000);
    assert.equal(
      history.hasObservedClearSince({ kind: 'train', line: 'red', direction: 'N', sinceTs: t0 }),
      true,
    );
    // Out of window
    assert.equal(
      history.hasObservedClearSince({ kind: 'train', line: 'red', direction: 'N', sinceTs: t0 + 5000 }),
      false,
    );
  } finally { cleanup(); }
});

test('ctaAlertPostedSince matches comma-bracketed route codes without false positives', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordAlertSeen({
      alertId: 'a1', kind: 'train', routes: 'Red,P',
      headline: 'h', postUri: 'at://x/y/a1',
    }, t0 + 1000);
    assert.equal(
      history.ctaAlertPostedSince({ kind: 'train', ctaRouteCode: 'Red', sinceTs: t0 }),
      true,
    );
    assert.equal(
      history.ctaAlertPostedSince({ kind: 'train', ctaRouteCode: 'P', sinceTs: t0 }),
      true,
    );
    // 'Re' must not match 'Red' via substring — comma boundary protects it.
    assert.equal(
      history.ctaAlertPostedSince({ kind: 'train', ctaRouteCode: 'Re', sinceTs: t0 }),
      false,
    );
    // Posted before the cutoff — out of window.
    assert.equal(
      history.ctaAlertPostedSince({ kind: 'train', ctaRouteCode: 'Red', sinceTs: t0 + 5000 }),
      false,
    );
  } finally { cleanup(); }
});

test('ctaAlertPostedSince ignores rows that have not been posted yet', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = 1_700_000_000_000;
    history.recordAlertSeen({
      alertId: 'a1', kind: 'train', routes: 'Red',
      headline: 'h', postUri: null,
    }, t0 + 1000);
    assert.equal(
      history.ctaAlertPostedSince({ kind: 'train', ctaRouteCode: 'Red', sinceTs: t0 }),
      false,
    );
  } finally { cleanup(); }
});
