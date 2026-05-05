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

test('gapCooldownAllows: decayed margin lets a smaller bump through later in cooldown', () => {
  // Prior post 45 min ago at ratio 2.70. Candidate 3.31 = 1.226× — fails the
  // 1.25× fresh margin, but at 45/60 of the cooldown window the margin has
  // decayed to ~1.1375, which 3.31 / 2.70 clears. Models the Purple 10:07 case.
  postedRatio('train', 'cd-decay', 2.7);
  const fortyFiveMinAgo = Date.now() - 45 * 60 * 1000;
  getDb()
    .prepare(`UPDATE gap_events SET ts = ? WHERE kind = 'train' AND route = 'cd-decay'`)
    .run(fortyFiveMinAgo);
  assert.equal(
    gapCooldownAllows({ kind: 'train', route: 'cd-decay', candidate: { ratio: 3.31 } }),
    true,
    '3.31 / 2.70 = 1.226× clears decayed margin at t=0.75 (≈1.14×)',
  );
});

test('gapCooldownAllows: sustained-severity floor fires after 20 min at ≥ 3.0×', () => {
  // Prior post 30 min ago at ratio 3.64. Candidate 3.06 is LOWER (no
  // escalation), so the margin gate fails. But ≥ 20 min elapsed and
  // candidate ≥ 3.0× → sustained-severity gate allows. Models the Blue
  // 16:22 follow-up case.
  postedRatio('train', 'cd-sustained', 3.64);
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  getDb()
    .prepare(`UPDATE gap_events SET ts = ? WHERE kind = 'train' AND route = 'cd-sustained'`)
    .run(thirtyMinAgo);
  assert.equal(
    gapCooldownAllows({ kind: 'train', route: 'cd-sustained', candidate: { ratio: 3.06 } }),
    true,
    '30 min elapsed + ratio 3.06 ≥ 3.0 floor → allow follow-up',
  );
});

test('gapCooldownAllows: sustained floor blocked when ratio drops below 3.0', () => {
  postedRatio('train', 'cd-belowfloor', 3.5);
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  getDb()
    .prepare(`UPDATE gap_events SET ts = ? WHERE kind = 'train' AND route = 'cd-belowfloor'`)
    .run(thirtyMinAgo);
  assert.equal(
    gapCooldownAllows({ kind: 'train', route: 'cd-belowfloor', candidate: { ratio: 2.8 } }),
    false,
    '30 min elapsed but 2.8 < 3.0 floor → still suppressed',
  );
});

test('gapCooldownAllows: sustained floor blocked when elapsed < 20 min', () => {
  postedRatio('train', 'cd-tooEarly', 3.5);
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  getDb()
    .prepare(`UPDATE gap_events SET ts = ? WHERE kind = 'train' AND route = 'cd-tooEarly'`)
    .run(tenMinAgo);
  assert.equal(
    gapCooldownAllows({ kind: 'train', route: 'cd-tooEarly', candidate: { ratio: 3.5 } }),
    false,
    '10 min elapsed < 20 min floor → no follow-up yet',
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
