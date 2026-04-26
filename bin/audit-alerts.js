#!/usr/bin/env node
// Periodic health audit of alerts + pulse state. Surfaces:
//   - alert_posts rows stuck without post_uri for >30 min (Bug 20 regressions)
//   - pulse_state rows with consecutive_ticks > 5 but active_post_uri null
//     (stuck debounces — pulse never managed to fire)
//   - cooldowns table size + age distribution (Bug 23 regressions)
// Exits non-zero on anomaly so cron-run.sh flags it.

require('../src/shared/env');

const { setup, runBin } = require('../src/shared/runBin');
const { getDb } = require('../src/shared/history');

async function main() {
  setup();
  const db = getDb();
  const now = Date.now();
  const issues = [];

  const stuckAlerts = db
    .prepare(`
    SELECT alert_id, kind, headline, first_seen_ts
    FROM alert_posts
    WHERE post_uri IS NULL AND resolved_ts IS NULL
      AND first_seen_ts < ?
    ORDER BY first_seen_ts
  `)
    .all(now - 30 * 60 * 1000);
  if (stuckAlerts.length > 0) {
    issues.push(`stuck-alerts: ${stuckAlerts.length} rows w/ post_uri=null older than 30 min`);
    for (const r of stuckAlerts.slice(0, 10)) {
      console.warn(
        `  alert_id=${r.alert_id} kind=${r.kind} age_min=${Math.round((now - r.first_seen_ts) / 60_000)} headline=${(r.headline || '').slice(0, 60)}`,
      );
    }
  }

  const stuckPulses = db
    .prepare(`
    SELECT line, direction, consecutive_ticks, started_ts
    FROM pulse_state
    WHERE active_post_uri IS NULL AND consecutive_ticks > 5
    ORDER BY started_ts
  `)
    .all();
  if (stuckPulses.length > 0) {
    issues.push(
      `stuck-pulses: ${stuckPulses.length} pulse_state rows with consecutive_ticks>5 but no active_post_uri`,
    );
    for (const r of stuckPulses) {
      console.warn(
        `  line=${r.line} direction=${r.direction} ticks=${r.consecutive_ticks} age_min=${r.started_ts ? Math.round((now - r.started_ts) / 60_000) : '?'}`,
      );
    }
  }

  const cooldownStats = db
    .prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END) AS expired_lingering,
      SUM(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) AS legacy_null_ttl
    FROM cooldowns
  `)
    .get(now);
  console.log(
    `cooldowns: total=${cooldownStats.total} expired-but-still-here=${cooldownStats.expired_lingering} legacy-null-ttl=${cooldownStats.legacy_null_ttl}`,
  );
  if (cooldownStats.expired_lingering > 100) {
    issues.push(
      `cooldowns: ${cooldownStats.expired_lingering} expired rows lingering — rolloffOld may not be running`,
    );
  }

  if (issues.length === 0) {
    console.log('audit-alerts: OK');
    return;
  }
  console.error(`audit-alerts: ${issues.length} issue(s):`);
  for (const i of issues) console.error(`  ${i}`);
  process.exit(1);
}

runBin(main);
