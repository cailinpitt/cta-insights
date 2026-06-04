// Create + configure the healthchecks.io checks for the monitored cron jobs.
//
// Auto-provisioning (the `?create=1` ping param) creates checks on first ping
// but only at healthchecks' loose defaults (period 1 day / grace 1 hour). This
// script upserts each monitored check via the Management API with a period +
// grace matched to its cron cadence, so the dashboard is meaningful without
// hand-editing 18 checks. Idempotent: re-run it any time HC_MONITORED in
// bin/cron-run.sh changes (it matches existing checks by name, never duplicates
// or deletes).
//
// Usage:  HC_API_KEY=<management-api-key> node scripts/configure-healthchecks.js
// The key is the project's read/write API key (Project Settings -> API Access),
// NOT the ping key. Pass it inline; it is deliberately not stored on disk.
//
// period = how often the job is expected to ping (cron cadence).
// grace  = how long it may be silent past the period before healthchecks pages.
//          Tuned per job: tight on the canaries, loose enough elsewhere to ride
//          out a transient blip. Mirrors the table in cron/healthchecks.env.example.
const M = 60; // seconds per minute, for readability below.

// slug -> { period, grace } in seconds. Keep in sync with HC_MONITORED in
// bin/cron-run.sh and the cron cadences in cron/crontab.txt.
const CHECKS = {
  // Every-minute canaries feeding the whole pipeline — page fast.
  'observe-buses': { period: 1 * M, grace: 7 * M },
  'observe-trains': { period: 1 * M, grace: 7 * M },
  // R2 publish loop, every 15 min (pings on no-op exits too).
  'push-web-data': { period: 15 * M, grace: 25 * M },
  // Posting bots, every 2 min.
  'bus-alerts': { period: 2 * M, grace: 10 * M },
  'bus-pulse': { period: 2 * M, grace: 10 * M },
  'train-alerts': { period: 2 * M, grace: 10 * M },
  'train-pulse': { period: 2 * M, grace: 10 * M },
  // Detectors, every 20 min.
  'bus-bunching': { period: 20 * M, grace: 15 * M },
  'bus-gaps': { period: 20 * M, grace: 15 * M },
  // Detectors, every 15 min.
  'bus-thin-gaps': { period: 15 * M, grace: 15 * M },
  'train-bunching': { period: 15 * M, grace: 15 * M },
  'train-gaps': { period: 15 * M, grace: 15 * M },
  // Hourly.
  'bus-ghosts': { period: 60 * M, grace: 20 * M },
  'train-ghosts': { period: 60 * M, grace: 20 * M },
  // Health audit, every 30 min.
  'audit-alerts': { period: 30 * M, grace: 20 * M },
  // Speedmaps, every 2 hours. Each run takes ~1h, so grace MUST exceed the
  // runtime: with /start pings, healthchecks marks a check down if the finish
  // ping doesn't arrive within grace of the start. 90m covers a ~1h run + buffer.
  'bus-speedmap': { period: 120 * M, grace: 90 * M },
  'train-speedmap': { period: 120 * M, grace: 90 * M },
  // GTFS refresh, daily at 03:15.
  'fetch-gtfs': { period: 24 * 60 * M, grace: 2 * 60 * M },
};

const API = 'https://healthchecks.io/api/v3/checks/';

async function main() {
  const apiKey = process.env.HC_API_KEY;
  if (!apiKey) {
    console.error('HC_API_KEY is required (the read/write Management API key).');
    process.exit(1);
  }

  let ok = 0;
  let failed = 0;
  for (const [slug, { period, grace }] of Object.entries(CHECKS)) {
    // `unique: ['name']` makes this an upsert keyed on the check name (== slug),
    // so re-runs update in place rather than creating duplicates. `channels: '*'`
    // assigns every notification channel that exists at write time — add your
    // channel first (or re-run this after) so new checks page you.
    const body = {
      name: slug,
      slug,
      timeout: period,
      grace,
      unique: ['name'],
      channels: '*',
    };
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        failed++;
        console.error(`✗ ${slug}: HTTP ${res.status} ${await res.text()}`);
        continue;
      }
      ok++;
      const verb = res.status === 201 ? 'created' : 'updated';
      console.log(`✓ ${slug.padEnd(16)} ${verb}  period=${period / M}m grace=${grace / M}m`);
    } catch (e) {
      failed++;
      console.error(`✗ ${slug}: ${e}`);
    }
  }
  console.log(`\n${ok} configured, ${failed} failed (of ${Object.keys(CHECKS).length}).`);
  if (failed) process.exit(1);
}

main();
