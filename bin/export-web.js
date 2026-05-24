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
const {
  describeBotObservation,
  describeBotResolution,
  describeBotEvidenceBullets,
  normalizeTrainLine,
} = require('../src/shared/observationDescribe');

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

// Extract the rkey at the end of a Bluesky post URL (the part after /post/).
// Mirrors cta-alert-history's postUrlRkey — the canonical per-incident id.
function postUrlRkey(postUrl) {
  if (!postUrl) return null;
  const m = /\/post\/([^/?#]+)/.exec(postUrl);
  return m ? m[1] : null;
}

// The CTA-side sub-block of a unified incident; null on bot-only incidents.
// Carries CTA's own lifecycle (first_seen_ts/resolved_ts/active) separately
// from the incident-level fields so a consumer can still compute the
// service-stabilization delta between CTA marking the alert cleared and the
// bot observing actual recovery.
function ctaBlock(alert) {
  const block = {
    alert_id: alert.alert_id,
    headline: alert.headline,
    short_description: alert.short_description ?? null,
    post_url: alert.post_url,
    resolved_reply_url: alert.resolved_reply_url,
    first_seen_ts: alert.first_seen_ts,
    resolved_ts: alert.resolved_ts ?? null,
    active: alert.active,
    affected_from_station: alert.affected_from_station ?? null,
    affected_to_station: alert.affected_to_station ?? null,
    affected_direction: alert.affected_direction ?? null,
    mentioned_stations: alert.mentioned_stations ?? [],
    cta_event_start_ts: alert.cta_event_start_ts ?? null,
    cta_event_end_ts: alert.cta_event_end_ts ?? null,
    cta_event_start_is_date_only: alert.cta_event_start_is_date_only ?? false,
    cta_event_end_is_date_only: alert.cta_event_end_is_date_only ?? false,
  };
  // versions is present on the built alert only when CTA edited it (>1 version).
  if (alert.versions && alert.versions.length > 1) block.versions = alert.versions;
  return block;
}

// Combine official CTA alerts and bot observations into one incident per
// underlying disruption. This is the merge that used to run client-side in
// cta-alert-history's mergeMatchingIncidents — moved here so the published JSON
// hands consumers ready-made incidents and the frontend stays a dumb renderer.
//
// An alert and an observation pair when they share kind + route and their time
// windows overlap (within 2h of the alert's onset, with a 10-min grace on the
// interval-overlap test). Unpaired alerts become cta-only incidents
// (observations: []); unpaired observations become bot-only incidents
// (cta: null).
//
// Train line keys are normalized to full names here ('g' -> 'green') so the
// public API reads naturally and the frontend no longer needs to normalize.
function buildIncidents(builtAlerts, builtObservations) {
  const BUFFER_MS = 2 * 60 * 60 * 1000; // 2h proximity on each side of onset
  const GRACE_MS = 10 * 60 * 1000; // interval-overlap slack

  const alerts = builtAlerts.map((a) =>
    a.kind === 'train' && Array.isArray(a.routes)
      ? { ...a, routes: a.routes.map(normalizeTrainLine) }
      : a,
  );
  const observations = builtObservations.map((o) =>
    o.kind === 'train' && o.line ? { ...o, line: normalizeTrainLine(o.line) } : o,
  );

  const usedObsIds = new Set();
  const incidents = [];

  for (const alert of alerts) {
    const matches = [];
    for (const obs of observations) {
      if (usedObsIds.has(obs.id)) continue;
      if (alert.kind !== obs.kind) continue;
      if (!alert.routes.includes(obs.line)) continue;
      // Anchor on first_seen_ts; require real interval overlap (with grace) so
      // an observation that resolved before the alert fired — or fired after it
      // cleared — can't merge on proximity alone.
      if (Math.abs(obs.ts - alert.first_seen_ts) > BUFFER_MS) continue;
      const obsEnd = obs.resolved_ts ?? obs.ts;
      const alertEnd = alert.resolved_ts ?? Number.POSITIVE_INFINITY;
      if (obsEnd + GRACE_MS < alert.first_seen_ts) continue;
      if (alertEnd + GRACE_MS < obs.ts) continue;
      matches.push(obs);
    }
    // Primary observation first: closest in time to the alert's onset.
    matches.sort(
      (a, b) => Math.abs(a.ts - alert.first_seen_ts) - Math.abs(b.ts - alert.first_seen_ts),
    );
    const active = alert.active || matches.some((o) => o.active);
    incidents.push({
      id: postUrlRkey(alert.post_url) ?? postUrlRkey(matches[0]?.post_url) ?? alert.alert_id,
      kind: alert.kind,
      routes: alert.routes,
      first_seen_ts: alert.first_seen_ts,
      // While active, don't report a resolution — a paired obs may carry its own
      // earlier resolved_ts, which would read as "ended before it started."
      resolved_ts: active ? null : (alert.resolved_ts ?? matches[0]?.resolved_ts ?? null),
      active,
      sources: matches.length > 0 ? ['cta', 'bot'] : ['cta'],
      cta: ctaBlock(alert),
      observations: matches,
    });
    for (const o of matches) usedObsIds.add(o.id);
  }

  // Bot observations with no matching CTA alert.
  for (const obs of observations) {
    if (usedObsIds.has(obs.id)) continue;
    incidents.push({
      id: postUrlRkey(obs.post_url) ?? String(obs.id),
      kind: obs.kind,
      routes: [obs.line],
      // ts is the post time; onset_ts (when present) is the back-dated start.
      // first_seen_ts tracks ts to match how observations sort/filter today;
      // onset_ts stays available inside the observation for duration math.
      first_seen_ts: obs.ts,
      resolved_ts: obs.resolved_ts ?? null,
      active: obs.active,
      sources: ['bot'],
      cta: null,
      observations: [obs],
    });
  }

  incidents.sort((a, b) => b.first_seen_ts - a.first_seen_ts);
  return incidents;
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

  // Per-alert version history. CTA edits the headline / body text on a live
  // alert as the situation evolves ("trains stopped" → "service restoring");
  // each edit lands as a row here. Only attached to the export when an alert
  // has >1 version so single-version alerts don't bloat the JSON.
  const versionRows = db
    .prepare(
      `SELECT alert_id, ts, headline, short_description,
              affected_from_station, affected_to_station, affected_direction
       FROM alert_versions
       ORDER BY alert_id, ts ASC`,
    )
    .all();
  const versionsByAlert = new Map();
  for (const row of versionRows) {
    let list = versionsByAlert.get(row.alert_id);
    if (!list) {
      list = [];
      versionsByAlert.set(row.alert_id, list);
    }
    list.push({
      ts: row.ts,
      headline: row.headline,
      short_description: row.short_description ?? null,
      affected_from_station: row.affected_from_station ?? null,
      affected_to_station: row.affected_to_station ?? null,
      affected_direction: row.affected_direction ?? null,
    });
  }

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
      `SELECT id, kind, line, ts, post_uri, resolved_ts, resolution_post_uri AS resolved_post_uri, signals, bullets AS bullets_json
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
      _bullets: parseEvidence(row.bullets_json),
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

  const builtAlerts = alerts.map((row) => ({
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
    // Successive edits CTA made to the alert text (headline / body /
    // affected scope). Only included when >1 version exists — a fresh
    // alert that CTA never edited is fully described by the top-level
    // headline/short_description, so the field stays absent there.
    ...(() => {
      const versions = versionsByAlert.get(row.alert_id);
      return versions && versions.length > 1 ? { versions } : {};
    })(),
  }));

  const builtObservations = observations.map((row) => {
    const detectionSource = row._source; // 'pulse-cold' | 'pulse-held' | 'thin-gap' | 'roundup'
    const signals = row.signals ? row.signals.split(',') : null;
    // Pre-render the plain-English sentences so the web app stays a dumb
    // renderer. Detection is always present when describable; the resolution
    // sentence is omitted when the observation is still active so the
    // renderer can branch on field presence rather than incident.active.
    const describeShape = {
      kind: row.kind,
      line: row.line,
      detection_source: detectionSource,
      signals,
      // Roundups: structured per-source picks from roundup_anchors.bullets.
      // Pulse-* / thin-gap: full evidence JSON from disruption_events.evidence.
      // describeBotEvidenceBullets reads whichever is appropriate.
      bullets: row._bullets ?? null,
      evidence: row._evidence ?? null,
    };
    const botDescription = describeBotObservation(describeShape);
    const botResolvedDescription =
      row.resolved_ts != null ? describeBotResolution(describeShape) : null;
    const botEvidenceBullets = describeBotEvidenceBullets(describeShape);

    // Absence-style observations (pulse-cold, thin-gap, roundups that bundle
    // them) are detected only once the corridor has *already* been cold for a
    // while — `ts` is when the bot posted, not when the disruption began. We
    // back-date the start to the last observed train so the reported duration
    // reflects the real outage length rather than the tiny post-to-resolve
    // window.
    //
    // Prefer `minutesSinceLastTrain` (the gap actually observed at post time)
    // over `coldThresholdMin` (the detector's floor) — when the corridor has
    // been cold longer than the threshold, the floor would under-count.
    // Roundups carry no observation-level evidence, so dig into the bullets
    // for the constituent pulse-cold / thin-gap pick.
    const onsetTs = (() => {
      const coldSources = new Set(['pulse-cold', 'thin-gap']);
      let backdateMin = null;
      if (row._evidence && coldSources.has(detectionSource)) {
        backdateMin = row._evidence.minutesSinceLastTrain ?? row._evidence.coldThresholdMin ?? null;
      } else if (Array.isArray(row._bullets)) {
        for (const b of row._bullets) {
          if (!coldSources.has(b?.source)) continue;
          const d = b.detail || {};
          const m = d.minutesSinceLastTrain ?? d.coldThresholdMin ?? null;
          if (m != null && (backdateMin == null || m > backdateMin)) backdateMin = m;
        }
      }
      // Only emit onset_ts when we genuinely back-dated to an earlier start;
      // for non-absence observations the start is just `ts` and onset_ts is null.
      return backdateMin != null ? row.ts - backdateMin * 60_000 : null;
    })();
    return {
      id: row.id,
      kind: row.kind,
      line: row.line,
      direction: row.direction ?? null,
      from_station: row.from_station ?? null,
      to_station: row.to_station ?? null,
      detection_source: detectionSource,
      signals, // e.g. ['gap', 'bunching']
      evidence: row._evidence ?? null,
      ts: row.ts,
      // Disruption start for absence-style observations, back-dated from `ts`
      // to the last observed train (see onsetTs above). Null when not
      // back-dated — consumers then fall back to `ts`. Kept as a distinct
      // field so `ts` always matches the post_url's actual post time.
      onset_ts: onsetTs,
      resolved_ts: row.resolved_ts ?? null,
      // duration_ms reconciles with the published timestamps:
      //   resolved_ts - (onset_ts ?? ts)
      // so a consumer that subtracts the start from resolved_ts gets the same
      // number. Null while still active.
      duration_ms: row.resolved_ts != null ? row.resolved_ts - (onsetTs ?? row.ts) : null,
      active: row.resolved_ts == null,
      post_url: atUriToUrl(row.post_uri),
      resolved_post_url: atUriToUrl(row.resolved_post_uri),
      bot_description: botDescription,
      bot_resolved_description: botResolvedDescription,
      // Concrete per-signal bullets pulled from the bluesky post body.
      // Omitted (undefined) when none — keeps the export lean and lets the
      // renderer treat absent and empty the same.
      ...(botEvidenceBullets && botEvidenceBullets.length > 0
        ? { bot_evidence_bullets: botEvidenceBullets }
        : {}),
    };
  });

  const incidents = buildIncidents(builtAlerts, builtObservations);

  const out = {
    generated_at: Date.now(),
    data_start_ts: dataStart.min_ts ?? null,
    alerts: builtAlerts,
    observations: builtObservations,
    incidents,
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
    let existingHasIncidents = false;
    if (Fs.existsSync(outputPath)) {
      try {
        const existing = JSON.parse(Fs.readFileSync(outputPath, 'utf8'));
        existingHasIncidents = Array.isArray(existing.incidents);
        existingDataOnly = JSON.stringify({
          data_start_ts: existing.data_start_ts,
          alerts: (existing.alerts || []).map(stripVolatile),
          observations: existing.observations,
        });
      } catch (_) {}
    }
    // Bootstrap: even when alerts/observations are byte-identical, force one
    // write if the existing file predates the incidents[] array, so the new
    // shape lands on first run. incidents derive deterministically from
    // alerts+observations, so the source-array comparison is a sufficient
    // change proxy on every subsequent run.
    if (dataOnly === existingDataOnly && existingHasIncidents) {
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

if (require.main === module) {
  main();
}

module.exports = { buildIncidents, ctaBlock, postUrlRkey };
