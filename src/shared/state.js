const { getDb } = require('./history');

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour default

// Cooldowns live in the shared SQLite DB so overlapping bot instances (timelapse
// captures can run ~10 min while cron fires every few minutes) see a consistent
// view and serialize on the DB's file lock. `acquireCooldown` is the only
// safe way to commit to a post — `isOnCooldown` is a cheap read used for early
// filtering in candidate loops, where a race producing a false-negative is
// still caught by the later acquire call.
//
// A key can carry an explicit expires_at (per-key TTL). When set, the row is
// "on cooldown" while now < expires_at. When null, the legacy behavior applies:
// on cooldown while now < ts + COOLDOWN_MS.

function isOnCooldown(key, now = Date.now()) {
  const row = getDb().prepare('SELECT ts, expires_at FROM cooldowns WHERE key = ?').get(key);
  if (!row) return false;
  if (row.expires_at != null) return now < row.expires_at;
  return now < row.ts + COOLDOWN_MS;
}

/**
 * Atomically try to acquire cooldowns for every key in `keys`. If any key is
 * already on cooldown, nothing is written and the function returns false.
 * Otherwise every key's ts is set to `now` and the function returns true.
 *
 * `ttlMs` (optional): if provided, sets expires_at = now + ttlMs for every key.
 *   Otherwise expires_at stays null and the legacy COOLDOWN_MS default applies.
 *
 * Cross-process safety comes from SQLite's file-level locking: the transaction
 * observes a consistent snapshot, and two processes calling this with
 * overlapping keys cannot both succeed.
 */
function acquireCooldown(keys, now = Date.now(), ttlMs = null) {
  const db = getDb();
  const check = db.prepare('SELECT ts, expires_at FROM cooldowns WHERE key = ?');
  const upsert = db.prepare(
    'INSERT INTO cooldowns (key, ts, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, expires_at = excluded.expires_at'
  );
  const expiresAt = ttlMs != null ? now + ttlMs : null;
  const tx = db.transaction((keyList) => {
    for (const k of keyList) {
      const row = check.get(k);
      if (!row) continue;
      const active = row.expires_at != null ? now < row.expires_at : now < row.ts + COOLDOWN_MS;
      if (active) return false;
    }
    for (const k of keyList) upsert.run(k, now, expiresAt);
    return true;
  });
  return tx(Array.isArray(keys) ? keys : [keys]);
}

/**
 * Clear cooldowns for the given keys. Used when an event resolves early and
 * we want to re-arm the detector (e.g. a posted CTA alert goes resolved, or
 * the pulse detector sees clear signals for N consecutive ticks).
 */
function clearCooldown(keys) {
  const db = getDb();
  const del = db.prepare('DELETE FROM cooldowns WHERE key = ?');
  const tx = db.transaction((keyList) => {
    for (const k of keyList) del.run(k);
  });
  tx(Array.isArray(keys) ? keys : [keys]);
}

module.exports = { isOnCooldown, acquireCooldown, clearCooldown, COOLDOWN_MS };
