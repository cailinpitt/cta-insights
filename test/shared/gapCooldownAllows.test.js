const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Os = require('node:os');
const Fs = require('node:fs');

const tmpDb = Path.join(Os.tmpdir(), `gapcd-test-${process.pid}-${Date.now()}.sqlite`);
process.env.HISTORY_DB_PATH = tmpDb;
const { gapCooldownAllows, recordGap, getDb } = require('../../src/shared/history');

test.after(() => {
  try {
    getDb().close();
  } catch (_e) {}
  try {
    Fs.unlinkSync(tmpDb);
  } catch (_e) {}
});

function postedRatio(kind, route, ratio) {
  recordGap({
    kind,
    route,
    direction: '5',
    gapFt: 5000,
    gapMin: ratio * 5,
    expectedMin: 5,
    ratio,
    nearStop: 'X',
    posted: true,
  });
}

test('gapCooldownAllows: no prior posts → allows', () => {
  assert.equal(
    gapCooldownAllows({ kind: 'bus', route: 'cd-empty', candidate: { ratio: 3.0 } }),
    true,
  );
});

test('gapCooldownAllows: candidate ≤ prior fails', () => {
  postedRatio('bus', 'cd-1', 3.0);
  assert.equal(
    gapCooldownAllows({ kind: 'bus', route: 'cd-1', candidate: { ratio: 3.0 } }),
    false,
    '3.0 == prior 3.0 should fail',
  );
});

test('gapCooldownAllows: 1.1× prior fails (within margin)', () => {
  postedRatio('bus', 'cd-2', 3.0);
  assert.equal(
    gapCooldownAllows({ kind: 'bus', route: 'cd-2', candidate: { ratio: 3.3 } }),
    false,
    '3.3 / 3.0 = 1.1× — under 1.25× margin, should fail',
  );
});

test('gapCooldownAllows: just under 1.25× still fails', () => {
  postedRatio('bus', 'cd-3', 3.0);
  assert.equal(
    gapCooldownAllows({ kind: 'bus', route: 'cd-3', candidate: { ratio: 3.74 } }),
    false,
    '3.74 / 3.0 = 1.247× — still under, should fail',
  );
});

test('gapCooldownAllows: ≥ 1.25× margin passes', () => {
  postedRatio('bus', 'cd-4', 3.0);
  assert.equal(
    gapCooldownAllows({ kind: 'bus', route: 'cd-4', candidate: { ratio: 3.76 } }),
    true,
    '3.76 / 3.0 = 1.253× — over 1.25× margin, should pass',
  );
});

test('gapCooldownAllows: must beat ALL prior posts in window', () => {
  postedRatio('train', 'cd-5', 3.0);
  postedRatio('train', 'cd-5', 5.0);
  assert.equal(
    gapCooldownAllows({ kind: 'train', route: 'cd-5', candidate: { ratio: 4.5 } }),
    false,
    '4.5 beats the 3.0 by margin but not the 5.0',
  );
  assert.equal(
    gapCooldownAllows({ kind: 'train', route: 'cd-5', candidate: { ratio: 6.5 } }),
    true,
    '6.5 / 5.0 = 1.3× — beats both with margin',
  );
});

test('gapCooldownAllows: outside withinMs window is ignored', () => {
  const longAgo = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
  getDb()
    .prepare(`UPDATE gap_events SET ts = ? WHERE kind = 'bus' AND route = 'cd-6'`)
    .run(longAgo);
  postedRatio('bus', 'cd-6', 5.0);
  // Most recent is 5.0 just now; we want to confirm older ones don't count.
  // Force the just-recorded 5.0 to be outside the window too:
  getDb()
    .prepare(`UPDATE gap_events SET ts = ? WHERE kind = 'bus' AND route = 'cd-6'`)
    .run(longAgo);
  assert.equal(
    gapCooldownAllows({
      kind: 'bus',
      route: 'cd-6',
      candidate: { ratio: 1.0 },
      withinMs: 60 * 60 * 1000,
    }),
    true,
    'no posts in last 60min → allows',
  );
});
