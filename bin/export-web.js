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
        alert_id, kind, routes, headline, short_description,
        first_seen_ts, last_seen_ts, resolved_ts,
        post_uri, resolved_reply_uri,
        affected_from_station, affected_to_station, affected_direction,
        mentioned_stations,
        cta_event_start_ts, cta_event_end_ts,
        cta_event_start_is_date_only, cta_event_end_is_date_only
       FROM alert_posts
       ORDER BY first_seen_ts DESC`,
    )
    .all();

  // Bot-detected disruptions (pulse observations). Each 'observed' /
  // 'observed-held' row is paired with the earliest matching
  // 'observed-clear' on the same line/direction/from/to after it, if one
  // exists. The held/cold distinction lives in d.source — we expose it as
  // a precise detection_source so the web UI can filter by subtype.
  const pulseObservations = db
    .prepare(
      `SELECT
        d.id, d.kind, d.line, d.direction, d.from_station, d.to_station,
        d.ts, d.post_uri, d.source AS pulse_source, d.evidence AS evidence_json,
        (
          SELECT MIN(c.ts)
          FROM disruption_events c
          WHERE c.kind = d.kind AND c.source = 'observed-clear' AND c.posted = 1
            AND c.ts >= d.ts
            AND IFNULL(c.line, '')          = IFNULL(d.line, '')
            AND IFNULL(c.direction, '')     = IFNULL(d.direction, '')
            AND IFNULL(c.from_station, '')  = IFNULL(d.from_station, '')
            AND IFNULL(c.to_station, '')    = IFNULL(d.to_station, '')
        ) AS resolved_ts,
        (
          SELECT c.post_uri
          FROM disruption_events c
          WHERE c.kind = d.kind AND c.source = 'observed-clear' AND c.posted = 1
            AND c.ts >= d.ts
            AND IFNULL(c.line, '')          = IFNULL(d.line, '')
            AND IFNULL(c.direction, '')     = IFNULL(d.direction, '')
            AND IFNULL(c.from_station, '')  = IFNULL(d.from_station, '')
            AND IFNULL(c.to_station, '')    = IFNULL(d.to_station, '')
          ORDER BY c.ts ASC LIMIT 1
        ) AS resolved_post_uri
       FROM disruption_events d
       WHERE d.source IN ('observed', 'observed-held', 'observed-thin') AND d.posted = 1 AND d.post_uri IS NOT NULL
       ORDER BY d.ts DESC`,
    )
    .all();

  // Multi-signal roundup posts (stored separately in roundup_anchors).
  const roundupObservations = db
    .prepare(
      `SELECT id, kind, line, ts, post_uri, resolved_ts, resolution_post_uri AS resolved_post_uri, signals
       FROM roundup_anchors
       ORDER BY ts DESC`,
    )
    .all();

  function parseStationList(json) {
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.length > 0) : [];
    } catch (_e) {
      return [];
    }
  }

  function parseEvidence(json) {
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch (_e) {
      return null;
    }
  }

  const observations = [
    ...pulseObservations.map((row) => ({
      ...row,
      // Map disruption_events.source to the web's precise detection_source.
      // 'observed-held' = held trains/buses; 'observed' = cold stretch;
      // 'observed-thin' = thin-service whole-route silence on a low-freq route.
      _source:
        row.pulse_source === 'observed-held'
          ? 'pulse-held'
          : row.pulse_source === 'observed-thin'
            ? 'thin-gap'
            : 'pulse-cold',
      _evidence: parseEvidence(row.evidence_json),
    })),
    ...roundupObservations.map((row) => ({
      ...row,
      direction: null,
      from_station: null,
      to_station: null,
      _source: 'roundup',
      // signals is already on row as a comma-separated string
    })),
  ].sort((a, b) => b.ts - a.ts);

  const dataStart = db
    .prepare(
      `SELECT MIN(ts) as min_ts FROM (
         SELECT MIN(first_seen_ts) as ts FROM alert_posts
         UNION ALL
         SELECT MIN(ts) as ts FROM disruption_events WHERE source IN ('observed', 'observed-held', 'observed-thin') AND posted = 1
         UNION ALL
         SELECT MIN(ts) as ts FROM roundup_anchors
       )`,
    )
    .get();

  db.close();

  const out = {
    generated_at: Date.now(),
    data_start_ts: dataStart.min_ts ?? null,
    alerts: alerts.map((row) => ({
      alert_id: row.alert_id,
      kind: row.kind,
      routes: row.routes ? row.routes.split(',').filter(Boolean) : [],
      headline: row.headline,
      short_description: row.short_description ?? null,
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
      // Station names mentioned anywhere in the alert text (impact-context
      // matches like "delays at Monroe"). Stored as a JSON array column;
      // omit the field when empty so the export stays lean and consumers
      // can treat absent and empty identically.
      mentioned_stations: parseStationList(row.mentioned_stations),
      // CTA's own claimed start/end for the alert. Populated when the alert
      // carried EventStart/EventEnd at fetch time. Survives even if the CTA
      // later scrubs the alert from their `?alertid=` lookup.
      cta_event_start_ts: row.cta_event_start_ts ?? null,
      cta_event_end_ts: row.cta_event_end_ts ?? null,
      // CTA sometimes posts EventStart/EventEnd as date-only ("2026-05-25").
      // We store those as end-of-day Chicago time but keep this flag so the
      // UI can render "Sun May 25" without an artificial 11:59 PM.
      cta_event_start_is_date_only: row.cta_event_start_is_date_only === 1,
      cta_event_end_is_date_only: row.cta_event_end_is_date_only === 1,
    })),
    observations: observations.map((row) => ({
      id: row.id,
      kind: row.kind,
      line: row.line,
      direction: row.direction ?? null,
      from_station: row.from_station ?? null,
      to_station: row.to_station ?? null,
      detection_source: row._source, // 'pulse-cold' | 'pulse-held' | 'roundup'
      signals: row.signals ? row.signals.split(',') : null, // e.g. ['gap', 'bunching']
      evidence: row._evidence ?? null,
      ts: row.ts,
      resolved_ts: row.resolved_ts ?? null,
      duration_ms: row.resolved_ts != null ? row.resolved_ts - row.ts : null,
      active: row.resolved_ts == null,
      post_url: atUriToUrl(row.post_uri),
      resolved_post_url: atUriToUrl(row.resolved_post_uri),
    })),
  };

  const outputPath = process.argv[2];

  if (outputPath) {
    // Only write if the data actually changed — generated_at updates every run
    // so we compare only alerts + observations to avoid spurious git commits.
    // last_seen_ts ticks forward on every re-sighting of an active alert; the
    // web UI only uses it as a coarse fallback bound (incidents.js, 2h buffer),
    // so excluding it from the comparison avoids commits with no real change.
    const stripVolatile = (alert) => {
      const { last_seen_ts: _ignored, ...rest } = alert;
      return rest;
    };
    const dataOnly = JSON.stringify({
      data_start_ts: out.data_start_ts,
      alerts: out.alerts.map(stripVolatile),
      observations: out.observations,
    });
    let existingDataOnly = null;
    if (Fs.existsSync(outputPath)) {
      try {
        const existing = JSON.parse(Fs.readFileSync(outputPath, 'utf8'));
        existingDataOnly = JSON.stringify({
          data_start_ts: existing.data_start_ts,
          alerts: (existing.alerts || []).map(stripVolatile),
          observations: existing.observations,
        });
      } catch (_) {}
    }
    if (dataOnly === existingDataOnly) {
      console.error('export-web: no data changes, skipping write');
      return;
    }
    Fs.writeFileSync(outputPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.error(
      `export-web: wrote ${out.alerts.length} alerts, ${out.observations.length} observations to ${outputPath}`,
    );
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

main();
