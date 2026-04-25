const { getDb } = require('./history');

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour default

// Cooldowns persist in SQLite so overlapping cron instances (timelapse captures
// can run ~10 min while cron fires every few minutes) serialize on the file
// lock. `acquireCooldown` is the only safe gate before posting; `isOnCooldown`
// is a cheap pre-filter where a false-negative gets caught by the later acquire.

function isOnCooldown(key, now = Date.now()) {
  const row = getDb().prepare('SELECT ts, expires_at FROM cooldowns WHERE key = ?').get(key);
  if (!row) return false;
  if (row.expires_at != null) return now < row.expires_at;
  return now < row.ts + COOLDOWN_MS;
}

// All-or-nothing acquire: returns false if any key is on cooldown, otherwise
// stamps `now` (and optional expires_at) on every key. SQLite file lock keeps
// two processes calling this with overlapping keys from both succeeding.
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

function clearCooldown(keys) {
  const db = getDb();
  const del = db.prepare('DELETE FROM cooldowns WHERE key = ?');
  const tx = db.transaction((keyList) => {
    for (const k of keyList) del.run(k);
  });
  tx(Array.isArray(keys) ? keys : [keys]);
}

module.exports = { isOnCooldown, acquireCooldown, clearCooldown, COOLDOWN_MS };
