const { getDb } = require('./history');

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Cooldowns live in the shared SQLite DB so overlapping bot instances (timelapse
// captures can run ~10 min while cron fires every few minutes) see a consistent
// view and serialize on the DB's file lock. `acquireCooldown` is the only
// safe way to commit to a post — `isOnCooldown` is a cheap read used for early
// filtering in candidate loops, where a race producing a false-negative is
// still caught by the later acquire call.

function isOnCooldown(key, now = Date.now()) {
  const cutoff = now - COOLDOWN_MS;
  const row = getDb().prepare('SELECT ts FROM cooldowns WHERE key = ? AND ts > ?').get(key, cutoff);
  return !!row;
}

/**
 * Atomically try to acquire cooldowns for every key in `keys`. If any key is
 * already on cooldown, nothing is written and the function returns false.
 * Otherwise every key's ts is set to `now` and the function returns true.
 *
 * Cross-process safety comes from SQLite's file-level locking: the transaction
 * observes a consistent snapshot, and two processes calling this with
 * overlapping keys cannot both succeed.
 */
function acquireCooldown(keys, now = Date.now()) {
  const cutoff = now - COOLDOWN_MS;
  const db = getDb();
  const check = db.prepare('SELECT 1 FROM cooldowns WHERE key = ? AND ts > ?');
  const upsert = db.prepare('INSERT INTO cooldowns (key, ts) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts');
  const tx = db.transaction((keyList) => {
    for (const k of keyList) {
      if (check.get(k, cutoff)) return false;
    }
    for (const k of keyList) upsert.run(k, now);
    return true;
  });
  return tx(Array.isArray(keys) ? keys : [keys]);
}

module.exports = { isOnCooldown, acquireCooldown, COOLDOWN_MS };
