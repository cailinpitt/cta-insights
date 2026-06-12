#!/usr/bin/env node
// Generate alerts.csv from the public alerts.json payload.
//
// This mirrors cta-alert-history's browser/download CSV schema, but lives in
// cta-insights so the R2 data publisher can ship JSON and CSV together.

const Fs = require('node:fs');

const CSV_COLUMNS = [
  'type',
  'id',
  'kind',
  'routes',
  'headline',
  'detection_source',
  'signals',
  'from_station',
  'to_station',
  'direction',
  'direction_label',
  'first_seen_ts',
  'onset_ts',
  'resolved_ts',
  'duration_minutes',
  'active',
  'post_url',
  'resolved_post_url',
  'cta_event_start_ts',
  'cta_event_end_ts',
  'cta_event_start_is_date_only',
  'cta_event_end_is_date_only',
];

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function isoOrEmpty(ms) {
  if (ms == null) return '';
  return new Date(ms).toISOString();
}

function observationSignals(obs) {
  if (!obs) return [];
  if (obs.detection_source === 'roundup') return obs.signals || [];
  return obs.detection_source ? [obs.detection_source] : [];
}

function incidentHeadlineText(inc) {
  if (!inc) return null;
  if (inc.title) return inc.title;
  if (inc.headline) return inc.headline;
  if (inc.cta?.headline) return inc.cta.headline;
  return null;
}

function flattenIncidents(incidents) {
  const alerts = [];
  const observations = [];
  for (const inc of incidents || []) {
    if (inc.cta) alerts.push(flattenIncidentAlert(inc));
    for (const o of inc.observations || []) observations.push({ ...o, _incidentId: inc.id });
  }
  return { alerts, observations };
}

function flattenIncidentAlert(inc) {
  const c = inc.cta;
  return {
    alert_id: c.alert_id,
    kind: inc.kind,
    routes: inc.routes,
    headline: incidentHeadlineText(inc) ?? c.headline,
    short_description: c.short_description ?? null,
    first_seen_ts: c.first_seen_ts,
    resolved_ts: c.resolved_ts ?? null,
    duration_ms: c.resolved_ts != null ? c.resolved_ts - c.first_seen_ts : null,
    active: c.active,
    post_url: c.post_url,
    resolved_reply_url: c.resolved_reply_url ?? null,
    affected_from_station: c.affected_from_station ?? null,
    affected_to_station: c.affected_to_station ?? null,
    affected_direction: c.affected_direction ?? null,
    cta_event_start_ts: c.cta_event_start_ts ?? null,
    cta_event_end_ts: c.cta_event_end_ts ?? null,
    cta_event_start_is_date_only: c.cta_event_start_is_date_only ?? false,
    cta_event_end_is_date_only: c.cta_event_end_is_date_only ?? false,
    _incidentId: inc.id,
  };
}

function alertRow(a) {
  return {
    type: 'alert',
    id: a.alert_id,
    kind: a.kind,
    routes: (a.routes ?? []).join(';'),
    headline: a.headline ?? '',
    detection_source: '',
    signals: '',
    from_station: a.affected_from_station ?? '',
    to_station: a.affected_to_station ?? '',
    direction: a.affected_direction ?? '',
    direction_label: '',
    first_seen_ts: isoOrEmpty(a.first_seen_ts),
    onset_ts: '',
    resolved_ts: isoOrEmpty(a.resolved_ts),
    duration_minutes:
      a.resolved_ts != null && a.first_seen_ts != null
        ? Math.round((a.duration_ms ?? a.resolved_ts - a.first_seen_ts) / 60_000)
        : '',
    active: a.active ? 'true' : 'false',
    post_url: a.post_url ?? '',
    resolved_post_url: a.resolved_reply_url ?? '',
    cta_event_start_ts: isoOrEmpty(a.cta_event_start_ts),
    cta_event_end_ts: isoOrEmpty(a.cta_event_end_ts),
    cta_event_start_is_date_only:
      a.cta_event_start_ts != null ? (a.cta_event_start_is_date_only ? 'true' : 'false') : '',
    cta_event_end_is_date_only:
      a.cta_event_end_ts != null ? (a.cta_event_end_is_date_only ? 'true' : 'false') : '',
  };
}

function observationRow(o) {
  return {
    type: 'observation',
    id: `obs-${o.id}`,
    kind: o.kind,
    routes: o.line ?? '',
    headline: '',
    detection_source: o.detection_source ?? '',
    signals: observationSignals(o).join(';'),
    from_station: o.from_station ?? '',
    to_station: o.to_station ?? '',
    direction: o.direction ?? '',
    direction_label: o.direction_label ?? '',
    first_seen_ts: isoOrEmpty(o.ts),
    onset_ts: isoOrEmpty(o.onset_ts),
    resolved_ts: isoOrEmpty(o.resolved_ts),
    duration_minutes:
      o.resolved_ts != null && o.ts != null
        ? Math.round((o.duration_ms ?? o.resolved_ts - (o.onset_ts ?? o.ts)) / 60_000)
        : '',
    active: o.active ? 'true' : 'false',
    post_url: o.post_url ?? '',
    resolved_post_url: o.resolved_post_url ?? '',
  };
}

function rowToCsv(row) {
  return CSV_COLUMNS.map((c) => csvEscape(row[c])).join(',');
}

function buildCsv(alerts, observations) {
  const rows = [...(alerts ?? []).map(alertRow), ...(observations ?? []).map(observationRow)].sort(
    (a, b) => (b.first_seen_ts < a.first_seen_ts ? -1 : b.first_seen_ts > a.first_seen_ts ? 1 : 0),
  );
  return `${[CSV_COLUMNS.join(','), ...rows.map(rowToCsv)].join('\n')}\n`;
}

function buildCsvFromPayload(payload) {
  const { alerts, observations } = flattenIncidents(payload?.incidents || []);
  return buildCsv(alerts, observations);
}

function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    console.error('usage: export-csv.js <alerts.json> <alerts.csv>');
    process.exit(2);
  }
  const payload = JSON.parse(Fs.readFileSync(input, 'utf8'));
  const csv = buildCsvFromPayload(payload);
  Fs.writeFileSync(output, csv, 'utf8');
  const rowCount = Math.max(0, csv.split('\n').length - 2);
  console.error(`export-csv: wrote ${rowCount} rows to ${output}`);
}

if (require.main === module) main();

module.exports = { buildCsv, buildCsvFromPayload, CSV_COLUMNS };
