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
  describeBotOnset,
  describeBotEvidenceBullets,
  normalizeTrainLine,
} = require('../src/shared/observationDescribe');
const { directionLabel } = require('../src/shared/directionLabel');
const { stationsOnSegment, normalizePulseDirection } = require('../src/shared/trainSegment');
const { ALL_LINES: METRA_LINE_ORDER_RAW } = require('../src/metra/lines');

const DB_PATH =
  process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');

// Lowercase a Metra GTFS route_id to its web key ('UP-W' → 'up-w'), matching the
// frontend's metraLines keys. Mirrors normalizeTrainLine for the Metra mode.
function normalizeMetraLine(key) {
  return key == null ? key : String(key).toLowerCase();
}

const METRA_LINE_ORDER = METRA_LINE_ORDER_RAW.map(normalizeMetraLine);

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

// The run number embedded in a Metra static trip_id: `RI_RI428_V7_B` → "428".
// Export only this compact identity for point observations so the web title can
// say when one incident spans several trains without shipping the full evidence.
function metraTrainNumberFromTripId(tripId) {
  if (tripId == null) return null;
  const parts = String(tripId).split('_');
  if (parts.length < 2) return null;
  const digits = parts[1].replace(/\D/g, '');
  return digits || null;
}

function officialMetraStatusFromText(alert) {
  if (alert.kind !== 'metra') return null;
  const text = [alert.headline, alert.short_description].filter(Boolean).join(' \n ');
  if (!text) return null;
  if (/\bwill\s+not\s+operate\b|\bcancell?ed\b|\bannull?ed\b|\bnot\s+running\b/i.test(text)) {
    return 'cancellation';
  }
  if (
    /\bdelay(?:ed|s)?\b|\b\d{1,3}\s*(?:\+|\s*or\s+more)?\s*minutes?\s+(?:late|behind|delay)/i.test(
      text,
    )
  ) {
    if (
      /\b(track\s+construction|construction|planned\s+work|work\s+zone|maintenance)\b/i.test(text)
    ) {
      return 'planned-delay';
    }
    return 'delay';
  }
  return null;
}

function metraTrainNumberFromAlertText(alert) {
  const text = [alert.headline, alert.short_description].filter(Boolean).join(' \n ');
  if (!text) return null;
  const trainMatch = /\btrain\s+#?(\d{1,4})\b/i.exec(text);
  if (trainMatch) return trainMatch[1];
  const shortMatch = /\b[A-Z]{2,5}\s*#(\d{1,4})\b/.exec(text);
  return shortMatch ? shortMatch[1] : null;
}

// Parse L train line names out of CTA alert text. CTA edits a live alert as
// the situation evolves and may drop lines from the headline once their
// service recovers (e.g. "Brown, Red and Purple Line Service Delayed" →
// "Brown Line Service Running with Delays"); without this the incident's
// final `routes` would lose the lines that were affected earlier.
const TRAIN_LINE_KEYS = ['red', 'blue', 'brown', 'green', 'orange', 'pink', 'purple', 'yellow'];
const TRAIN_LINE_REGEX = new RegExp(`\\b(${TRAIN_LINE_KEYS.join('|')})\\b`, 'gi');
function trainLinesFromText(text) {
  if (!text) return [];
  const found = new Set();
  for (const m of text.matchAll(TRAIN_LINE_REGEX)) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

// Every roster station on a CTA "between X and Y" alert's affected segment,
// inclusive of the endpoints. Enumerated per route (a station set differs by
// line) and unioned, so a Brown-Line "Rockwell → Montrose" alert ties to the
// inner Western/Damen stops too, not just the two named endpoints. `routes`
// here are the raw short line keys ('brn'); affected_direction is already one
// of north/south/east/west/in/out|null, which stationsOnSegment accepts as its
// branch hint. Empty when there's no segment to enumerate (no from/to, a bus
// alert, or nothing resolves) — consumers then fall back to the endpoints.
function affectedStationsForAlert(row) {
  if (row.kind !== 'train') return [];
  if (!row.affected_from_station || !row.affected_to_station) return [];
  const routes = row.routes ? row.routes.split(',').filter(Boolean) : [];
  const seen = new Set();
  const out = [];
  for (const line of routes) {
    for (const name of stationsOnSegment({
      line,
      direction: row.affected_direction ?? null,
      fromStation: row.affected_from_station,
      toStation: row.affected_to_station,
    })) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

// The CTA-side sub-block of a unified incident; null on bot-only incidents.
// Carries CTA's own lifecycle (first_seen_ts/resolved_ts/active) separately
// from the incident-level fields so a consumer can still compute the
// service-stabilization delta between CTA marking the alert cleared and the
// bot observing actual recovery.
function lifecycleBlock({ firstSeenTs, resolvedTs, active, durationMs, onsetTs }) {
  return {
    first_seen_ts: firstSeenTs,
    ...(onsetTs != null ? { onset_ts: onsetTs } : {}),
    resolved_ts: resolvedTs ?? null,
    active,
    duration_ms:
      durationMs ?? (resolvedTs != null && firstSeenTs != null ? resolvedTs - firstSeenTs : null),
  };
}

function agencyForKind(kind) {
  return kind === 'metra' ? 'metra' : 'cta';
}

function officialSourceForKind(kind) {
  return agencyForKind(kind);
}

function modeForKind(kind) {
  if (kind === 'metra') return 'commuter_rail';
  return kind;
}

function alertScope(alert) {
  return {
    from_station: alert.affected_from_station ?? null,
    to_station: alert.affected_to_station ?? null,
    stations: alert.affected_stations ?? [],
    direction: alert.affected_direction ?? null,
    mentioned_stations: alert.mentioned_stations ?? [],
  };
}

function agencyEventWindow(alert) {
  return {
    start_ts: alert.cta_event_start_ts ?? null,
    end_ts: alert.cta_event_end_ts ?? null,
    start_is_date_only: alert.cta_event_start_is_date_only ?? false,
    end_is_date_only: alert.cta_event_end_is_date_only ?? false,
  };
}

function officialAlertBlock(alert) {
  const block = {
    id: alert.alert_id,
    headline: alert.headline,
    description: alert.short_description ?? null,
    post_url: alert.post_url,
    resolved_reply_url: alert.resolved_reply_url,
    lifecycle: lifecycleBlock({
      firstSeenTs: alert.first_seen_ts,
      resolvedTs: alert.resolved_ts ?? null,
      active: alert.active,
      durationMs: alert.duration_ms ?? null,
    }),
    scope: alertScope(alert),
    agency_event_window: agencyEventWindow(alert),
  };
  // versions is present on the built alert only when CTA edited it (>1 version).
  if (alert.versions && alert.versions.length > 1) block.versions = alert.versions;
  return block;
}

function statusBlock(alert) {
  if (alert.kind !== 'metra') return null;
  if (alert.cancellation?.state) {
    return {
      type: 'cancellation',
      state: alert.cancellation.state,
      train_number: alert.cancellation.train_number ?? null,
      scheduled_departure_ts: alert.cancellation.scheduled_departure_ts ?? null,
      scheduled_arrival_ts: alert.cancellation.scheduled_arrival_ts ?? null,
      origin: alert.cancellation.origin ?? null,
    };
  }
  if (alert.delay_deadline_ts != null) {
    return {
      type: 'delay',
      deadline_ts: alert.delay_deadline_ts,
      delay_min: alert.delay_min ?? null,
      train_number: alert.delay_train_no ?? null,
    };
  }
  const source = officialMetraStatusFromText(alert);
  if (source) {
    return {
      type: source,
      train_number: metraTrainNumberFromAlertText(alert),
    };
  }
  return null;
}

function detectionScope(obs) {
  return {
    route: obs.line ?? null,
    direction: obs.direction ?? null,
    direction_label: obs.direction_label ?? null,
    from_station: obs.from_station ?? null,
    to_station: obs.to_station ?? null,
    stations: obs.stations ?? [],
  };
}

function detectionBlock(obs) {
  return {
    id: obs.id,
    source: obs.detection_source,
    scope: detectionScope(obs),
    lifecycle: lifecycleBlock({
      firstSeenTs: obs.ts,
      onsetTs: obs.onset_ts ?? null,
      resolvedTs: obs.resolved_ts ?? null,
      active: obs.active,
      durationMs: obs.duration_ms ?? null,
    }),
    post_url: obs.post_url ?? null,
    resolved_post_url: obs.resolved_post_url ?? null,
    description: obs.bot_description ?? null,
    evidence: {
      signals: obs.signals ?? null,
      details: obs.evidence ?? null,
      bullets: obs.bot_evidence_bullets ?? [],
      onset_description: obs.onset_description ?? null,
      train_number: obs.train_number ?? null,
      resolved_description: obs.bot_resolved_description ?? null,
    },
  };
}

function statusFromDetection(obs) {
  if (obs.kind !== 'metra') return null;
  if (obs.detection_source === 'delay') {
    return {
      type: 'delay',
      train_number: obs.train_number ?? null,
      scheduled_departure_ts: obs.onset_ts ?? null,
    };
  }
  if (obs.detection_source === 'cancellation' || obs.detection_source === 'cancellation-inferred') {
    return {
      type: obs.detection_source,
      train_number: obs.train_number ?? null,
      scheduled_departure_ts: obs.onset_ts ?? null,
    };
  }
  return null;
}

function plainTextKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[.,;:!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function plannedWorkDateKey(incident) {
  const alert = incident.official_alert;
  const text = [alert?.headline, alert?.description].filter(Boolean).join(' ');
  const m =
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+([a-z]+)\s+(\d{1,2})\s+through\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+([a-z]+)\s+(\d{1,2})\b/i.exec(
      text,
    );
  if (!m) return null;
  return `${m[1].toLowerCase()}-${m[2]}-${m[3].toLowerCase()}-${m[4]}`;
}

function normalizedPlannedWorkDescription(s) {
  return plainTextKey(s)
    .replace(/\bup to \d+\s+minutes?\b/g, 'up to n minutes')
    .replace(/\b\d+\s*(?:to|-)\s*\d+\s+minutes?\b/g, 'n minutes')
    .replace(/\b\d+\s+minutes?\b/g, 'n minutes');
}

function metraRouteRank(incident) {
  const route = incident.routes?.[0] ?? '';
  const idx = METRA_LINE_ORDER.indexOf(route);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function canonicalIncidentSort(a, b) {
  return (
    (a.lifecycle.first_seen_ts ?? Number.MAX_SAFE_INTEGER) -
      (b.lifecycle.first_seen_ts ?? Number.MAX_SAFE_INTEGER) ||
    metraRouteRank(a) - metraRouteRank(b) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function plannedMetraGroupKey(incident) {
  if (incident.agency !== 'metra') return null;
  if (incident.mode !== 'commuter_rail') return null;
  if (incident.status?.type !== 'planned-delay') return null;
  if (!incident.official_alert) return null;
  const headline = plainTextKey(incident.official_alert.headline);
  const description = normalizedPlannedWorkDescription(incident.official_alert.description);
  const text = `${headline} ${description}`;
  if (!/\b(track construction|construction|planned work|work zone|maintenance)\b/.test(text)) {
    return null;
  }
  if (!/\bdelay/.test(text) && !/\bn minutes?\b/.test(text)) return null;
  const dateKey = plannedWorkDateKey(incident);
  if (!dateKey) return null;
  return [headline, dateKey, description].join('|');
}

function sortRoutesForMode(mode, routes) {
  const unique = [...new Set((routes || []).filter(Boolean))];
  if (mode === 'commuter_rail') {
    return unique.sort((a, b) => {
      const ai = METRA_LINE_ORDER.indexOf(a);
      const bi = METRA_LINE_ORDER.indexOf(b);
      return (
        (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi) ||
        String(a).localeCompare(String(b))
      );
    });
  }
  return unique;
}

function mergeLifecycle(lifecycles) {
  const firstSeen = Math.min(...lifecycles.map((l) => l?.first_seen_ts).filter((ts) => ts != null));
  const active = lifecycles.some((l) => l?.active);
  const resolvedValues = lifecycles.map((l) => l?.resolved_ts).filter((ts) => ts != null);
  const resolvedTs = active || resolvedValues.length === 0 ? null : Math.max(...resolvedValues);
  return lifecycleBlock({
    firstSeenTs: Number.isFinite(firstSeen) ? firstSeen : null,
    resolvedTs,
    active,
  });
}

function consolidateMetraPlannedWorkIncidents(incidents) {
  const groups = new Map();
  const passthrough = [];
  for (const incident of incidents) {
    const key = plannedMetraGroupKey(incident);
    if (!key) {
      passthrough.push(incident);
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(incident);
  }

  const consolidated = [...passthrough];
  for (const group of groups.values()) {
    if (group.length === 1) {
      consolidated.push(group[0]);
      continue;
    }
    const sorted = [...group].sort(canonicalIncidentSort);
    const primary = sorted[0];
    const routes = sortRoutesForMode(
      primary.mode,
      sorted.flatMap((incident) => incident.routes || []),
    );
    const detections = sorted.flatMap((incident) => incident.detections || []);
    const sources = [...new Set(sorted.flatMap((incident) => incident.sources || []))];
    const officialAlerts = sorted
      .map((incident) => incident.official_alert)
      .filter(Boolean)
      .sort((a, b) => {
        const al = a.lifecycle ?? {};
        const bl = b.lifecycle ?? {};
        return (
          (al.first_seen_ts ?? Number.MAX_SAFE_INTEGER) -
            (bl.first_seen_ts ?? Number.MAX_SAFE_INTEGER) ||
          String(a.id).localeCompare(String(b.id))
        );
      });
    consolidated.push({
      ...primary,
      id: primary.id,
      routes,
      sources,
      lifecycle: mergeLifecycle(sorted.map((incident) => incident.lifecycle)),
      official_alert: primary.official_alert,
      official_alerts: officialAlerts,
      detections,
      status: primary.status,
    });
  }

  consolidated.sort((a, b) => b.lifecycle.first_seen_ts - a.lifecycle.first_seen_ts);
  return consolidated;
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

  const alerts = builtAlerts.map((a) => {
    if (a.kind === 'train' && Array.isArray(a.routes)) {
      return { ...a, routes: a.routes.map(normalizeTrainLine) };
    }
    // Metra routes arrive as raw GTFS route_ids ('UP-W'); the frontend keys
    // metadata by the lowercase web key ('up-w').
    if (a.kind === 'metra' && Array.isArray(a.routes)) {
      return { ...a, routes: a.routes.map(normalizeMetraLine) };
    }
    return a;
  });
  const observations = builtObservations.map((o) => {
    if (o.kind === 'train' && o.line) return { ...o, line: normalizeTrainLine(o.line) };
    if (o.kind === 'metra' && o.line) return { ...o, line: normalizeMetraLine(o.line) };
    return o;
  });

  const usedObsIds = new Set();
  const incidents = [];

  for (const alert of alerts) {
    const matches = [];
    // Planned-work Metra notices (scheduled track construction/maintenance)
    // describe a future window spanning many lines. They must not absorb live
    // per-train delay/cancellation observations that merely share a line and
    // fall inside the 2h proximity window — doing so mislabels the planned
    // notice with unrelated trains (e.g. a track-construction post retitled
    // "trains #612 and #614 affected"). Leave the notice as a cta-only incident
    // and let the live observations stand on their own as bot-only incidents.
    const isPlannedMetra = alert.kind === 'metra' && statusBlock(alert)?.type === 'planned-delay';
    for (const obs of observations) {
      if (isPlannedMetra) break;
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
    // Earliest detection across sources — the bot's pulse-cold/thin-gap onset
    // can predate CTA's post by tens of minutes, and the incident-level
    // "first seen" should reflect that lead. CTA's own first_seen_ts is still
    // preserved inside the `cta` block so consumers that want CTA's post time
    // (e.g. lead-time analytics) can still get it.
    const earliestObs = matches.reduce(
      (min, o) => Math.min(min, o.onset_ts ?? o.ts),
      Number.POSITIVE_INFINITY,
    );
    const incidentFirstSeen = Math.min(alert.first_seen_ts, earliestObs);
    // Routes union: alert_posts.routes is overwritten on each CTA edit, so a
    // multi-line alert that CTA narrows to a single line before resolving
    // would otherwise drop the dropped lines from the incident entirely.
    // Re-derive from every version's text + matched obs lines so the
    // incident reflects every line ever affected.
    let incidentRoutes = alert.routes;
    if (alert.kind === 'train') {
      const union = new Set(alert.routes);
      const texts = [alert.headline, alert.short_description];
      if (Array.isArray(alert.versions)) {
        for (const v of alert.versions) {
          texts.push(v.headline, v.short_description);
        }
      }
      for (const t of texts) {
        for (const line of trainLinesFromText(t)) union.add(line);
      }
      for (const o of matches) if (o.line) union.add(o.line);
      incidentRoutes = TRAIN_LINE_KEYS.filter((k) => union.has(k));
    }
    incidents.push({
      id: postUrlRkey(alert.post_url) ?? postUrlRkey(matches[0]?.post_url) ?? alert.alert_id,
      agency: agencyForKind(alert.kind),
      mode: modeForKind(alert.kind),
      routes: incidentRoutes,
      sources:
        matches.length > 0
          ? [officialSourceForKind(alert.kind), 'bot']
          : [officialSourceForKind(alert.kind)],
      lifecycle: lifecycleBlock({
        firstSeenTs: incidentFirstSeen,
        // While active, don't report a resolution — a paired obs may carry its own
        // earlier resolved_ts, which would read as "ended before it started."
        resolvedTs: active ? null : (alert.resolved_ts ?? matches[0]?.resolved_ts ?? null),
        active,
      }),
      official_alert: officialAlertBlock(alert),
      detections: matches.map(detectionBlock),
      status: statusBlock(alert),
    });
    for (const o of matches) usedObsIds.add(o.id);
  }

  // Bot observations with no matching CTA alert.
  for (const obs of observations) {
    if (usedObsIds.has(obs.id)) continue;
    incidents.push({
      id: postUrlRkey(obs.post_url) ?? String(obs.id),
      agency: agencyForKind(obs.kind),
      mode: modeForKind(obs.kind),
      routes: [obs.line],
      sources: ['bot'],
      lifecycle: lifecycleBlock({
        // ts is the post time; onset_ts (when present) is the back-dated start.
        // first_seen_ts tracks ts to match how observations sort/filter today.
        firstSeenTs: obs.ts,
        resolvedTs: obs.resolved_ts ?? null,
        active: obs.active,
        durationMs: obs.duration_ms ?? null,
      }),
      official_alert: null,
      detections: [detectionBlock(obs)],
      status: statusFromDetection(obs),
    });
  }

  incidents.sort((a, b) => b.lifecycle.first_seen_ts - a.lifecycle.first_seen_ts);
  return consolidateMetraPlannedWorkIncidents(incidents);
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
        cta_event_start_is_date_only, cta_event_end_is_date_only,
        cancel_state, cancel_dep_ts, cancel_arr_ts, cancel_train_no, cancel_origin,
        delay_deadline_ts, delay_min, delay_train_no
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
          WHERE c.kind = d.kind AND c.source = 'observed-clear'
            AND c.ts >= d.ts
            AND IFNULL(c.line, '')          = IFNULL(d.line, '')
            AND IFNULL(c.direction, '')     = IFNULL(d.direction, '')
            AND IFNULL(c.from_station, '')  = IFNULL(d.from_station, '')
            AND IFNULL(c.to_station, '')    = IFNULL(d.to_station, '')
        ) AS resolved_ts,
        (
          SELECT c.post_uri
          FROM disruption_events c
          WHERE c.kind = d.kind AND c.source = 'observed-clear'
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

  // Metra cancellations + delays. Recorded website-data-first (posted=0, no
  // individual post_uri — the per-trip detail the hourly rollup summarizes), so
  // unlike the CTA pulse query above this is NOT gated on posted=1. Each row is a
  // point-in-time event (a train cancelled / a train that ran late).
  const metraObservations = db
    .prepare(
      `SELECT id, kind, line, direction, from_station, to_station, ts,
              source AS metra_source, evidence AS evidence_json
       FROM disruption_events
       WHERE kind = 'metra'
         AND source IN ('cancellation', 'cancellation-inferred', 'delay')
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
    // Inner-station fill of the "between X and Y" segment (endpoints included),
    // enumerated per route from the line geometry. Lets stations between the
    // two named endpoints tie to the incident, not just the endpoints.
    affected_stations: affectedStationsForAlert(row),
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
    // Schedule-anchored single-train Metra cancellation. Present (non-null) only
    // when the alert annuls exactly one scheduled train. `state` is the rider-
    // facing label ('upcoming' before the scheduled departure, 'cancelled' after);
    // the departure/arrival are that train's timetable, and the frontend renders
    // the window + state directly (no client-side clock math). Null for every
    // open-ended notice, which keeps the ongoing→resolved model via resolved_ts.
    cancellation: row.cancel_state
      ? {
          state: row.cancel_state,
          scheduled_departure_ts: row.cancel_dep_ts ?? null,
          scheduled_arrival_ts: row.cancel_arr_ts ?? null,
          train_number: row.cancel_train_no ?? null,
          origin: row.cancel_origin ?? null,
        }
      : null,
    delay_deadline_ts: row.delay_deadline_ts ?? null,
    delay_min: row.delay_min ?? null,
    delay_train_no: row.delay_train_no ?? null,
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
    // Onset timeline-entry text — only when we back-dated to a start
    // meaningfully (≥5 min) before the post time. Gated alongside onset_ts so
    // the renderer never shows a "started here" dot a minute before detection.
    const onsetDescription =
      onsetTs != null && row.ts - onsetTs >= 5 * 60_000 ? describeBotOnset(describeShape) : null;
    // Full station fill of the observed stretch (endpoints + inner stops), so a
    // gap from Rockwell → Montrose ties to Western and Damen too. Empty for
    // roundups (no from/to) and anything that can't be resolved — the field is
    // omitted then and consumers fall back to from_station/to_station.
    const segStations =
      row.kind === 'train'
        ? stationsOnSegment({
            line: row.line,
            direction: normalizePulseDirection(row.direction),
            fromStation: row.from_station,
            toStation: row.to_station,
          })
        : [];
    return {
      id: row.id,
      kind: row.kind,
      line: row.line,
      direction: row.direction ?? null,
      // Pre-computed "toward <terminus>" string for the renderer. Translates
      // the opaque branch-N-outbound / branch-len… direction key into a
      // rider-facing label; null when the key carries no usable direction
      // (e.g. `all` on single-branch lines, or buses where direction is null).
      direction_label: directionLabel(row.line, row.direction) ?? null,
      from_station: row.from_station ?? null,
      to_station: row.to_station ?? null,
      // Every roster stop on the observed stretch, endpoints included (see
      // segStations above). Omitted when empty so absent and empty read the
      // same and the export stays lean.
      ...(segStations.length > 0 ? { stations: segStations } : {}),
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
      // Sentence for the onset timeline entry (start-of-issue). Omitted when
      // there's no meaningful back-date — renderer then shows no onset dot.
      ...(onsetDescription ? { onset_description: onsetDescription } : {}),
    };
  });

  // Metra cancellation/delay observations → bot-only incidents. Point events
  // (a train was cancelled / ran late), so first_seen = resolved = ts and there's
  // no individual post (the hourly rollup summarizes them). `detection_source`
  // carries the Metra signal kind the frontend's signal vocab renders.
  const builtMetraObservations = metraObservations.map((row) => {
    const ev = parseEvidence(row.evidence_json) || {};
    const source = row.metra_source; // 'cancellation' | 'cancellation-inferred' | 'delay'
    const line = normalizeMetraLine(row.line);
    const train = [ev.scheduledDepLabel, ev.headsign].filter(Boolean).join(' ');
    const botDescription =
      source === 'delay'
        ? `${ev.delayMin ? `~${ev.delayMin} min late` : 'Running late'}${train ? ` — the ${train} train` : ''}`
        : source === 'cancellation'
          ? `Cancelled${train ? ` — the ${train} train` : ''}`
          : `Scheduled train not seen running${train ? ` — the ${train} train` : ''}`;
    return {
      id: `metra-${row.id}`,
      kind: 'metra',
      line,
      direction: row.direction ?? null,
      from_station: row.from_station ?? null,
      to_station: row.to_station ?? null,
      train_number: metraTrainNumberFromTripId(ev.tripId),
      detection_source: source,
      signals: null,
      // No `evidence` here: the frontend's formatEvidenceChip has no branch for
      // the Metra cancellation/delay evidence shape (tripId/serviceDate/headsign/
      // …), so it was shipped to every client but never rendered. The rider-
      // facing bits are already baked into `bot_description` and `onset_ts`
      // above, so dropping it is lossless for consumers (~35KB/payload on a
      // heavy-cancellation day). `ev` is still used locally just above.
      ts: row.ts,
      // Back-date to the scheduled departure so the timeline reflects when the
      // train was due, not when the hourly rollup noticed.
      onset_ts: ev.scheduledDepTs ?? null,
      resolved_ts: row.ts,
      duration_ms: null,
      active: false,
      post_url: null,
      resolved_post_url: null,
      bot_description: botDescription,
    };
  });

  const incidents = buildIncidents(builtAlerts, [...builtObservations, ...builtMetraObservations]);

  const out = {
    schema_version: 2,
    generated_at: Date.now(),
    data_start_ts: dataStart.min_ts ?? null,
    incidents,
  };

  const outputPath = process.argv[2];

  if (outputPath) {
    // Only write if the data actually changed — generated_at updates every run,
    // so compare just the incidents (+ data_start_ts) to avoid spurious git
    // commits. incidents carry no volatile per-run fields (last_seen_ts is
    // deliberately omitted from the cta block), so a direct compare is stable:
    // re-sighting an unchanged active alert produces byte-identical incidents.
    const dataOnly = JSON.stringify({
      data_start_ts: out.data_start_ts,
      schema_version: out.schema_version,
      incidents: out.incidents,
    });
    let existingDataOnly = null;
    let existingHasLegacy = false;
    if (Fs.existsSync(outputPath)) {
      try {
        const existing = JSON.parse(Fs.readFileSync(outputPath, 'utf8'));
        // A file written before incidents[] became the sole shape still carries
        // the legacy top-level alerts[]/observations[] arrays we no longer emit.
        existingHasLegacy = 'alerts' in existing || 'observations' in existing;
        existingDataOnly = JSON.stringify({
          data_start_ts: existing.data_start_ts,
          schema_version: existing.schema_version,
          incidents: existing.incidents,
        });
      } catch (_) {}
    }
    // Skip only when the incidents are unchanged AND the file is already in the
    // incidents-only shape. The legacy check forces one write to strip a stale
    // alerts[]/observations[] file even when its incidents happen to match.
    if (dataOnly === existingDataOnly && !existingHasLegacy) {
      console.error('export-web: no data changes, skipping write');
      return;
    }
    // Minified, not pretty-printed: this file is the R2 payload every client
    // downloads + parses on load (and re-fetches no-store every 5 min). Since
    // the R2 migration it's no longer committed to git, so the human-readable
    // indentation served nobody and just inflated the payload (~360KB / ~30% was
    // whitespace) and parse time. Stdout below stays pretty for manual/debug use.
    Fs.writeFileSync(outputPath, `${JSON.stringify(out)}\n`, 'utf8');
    console.error(`export-web: wrote ${out.incidents.length} incidents to ${outputPath}`);
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildIncidents,
  consolidateMetraPlannedWorkIncidents,
  officialAlertBlock,
  metraTrainNumberFromTripId,
  postUrlRkey,
};
