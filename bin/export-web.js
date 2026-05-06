#!/usr/bin/env node
// Exports historical alert data from the SQLite DB to JSON for the public web
// dashboard. Reads the DB in readonly mode — safe to run alongside cron jobs.
//
// Usage:
//   node bin/export-web.js [output-path]
//
// If output-path is omitted, JSON is written to stdout. The typical cron
// wrapper clones the GitHub Pages repo, runs this script pointing at
// data/alerts.json inside that clone, then commits + pushes only if the
// file changed.

require('../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');

// Convert an AT Protocol post URI to a bsky.app URL, or null if the URI is
// missing / malformed.
function atUriToUrl(uri) {
  if (!uri) return null;
  // at://did:plc:xxx/app.bsky.feed.post/rkey
  const parts = uri.split('/');
  if (parts.length < 5) return null;
  const did = parts[2];
  const rkey = parts[4];
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const alerts = db
    .prepare(
      `SELECT
        alert_id, kind, routes, headline,
        first_seen_ts, last_seen_ts, resolved_ts,
        post_uri, resolved_reply_uri,
        affected_from_station, affected_to_station, affected_direction
       FROM alert_posts
       ORDER BY first_seen_ts DESC`,
    )
    .all();

  db.close();

  const out = {
    generated_at: Date.now(),
    alerts: alerts.map((row) => ({
      alert_id: row.alert_id,
      kind: row.kind,
      routes: row.routes ? row.routes.split(',').filter(Boolean) : [],
      headline: row.headline,
      first_seen_ts: row.first_seen_ts,
      last_seen_ts: row.last_seen_ts,
      resolved_ts: row.resolved_ts ?? null,
      duration_ms: row.resolved_ts != null ? row.resolved_ts - row.first_seen_ts : null,
      active: row.resolved_ts == null,
      post_url: atUriToUrl(row.post_uri),
      resolved_reply_url: atUriToUrl(row.resolved_reply_uri),
      affected_from_station: row.affected_from_station ?? null,
      affected_to_station: row.affected_to_station ?? null,
      affected_direction: row.affected_direction ?? null,
    })),
  };

  const json = JSON.stringify(out, null, 2);
  const outputPath = process.argv[2];

  if (outputPath) {
    Fs.writeFileSync(outputPath, json + '\n', 'utf8');
    console.error(`export-web: wrote ${out.alerts.length} alerts to ${outputPath}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main();
