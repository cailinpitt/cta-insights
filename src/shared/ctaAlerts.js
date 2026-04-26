// Docs: https://www.transitchicago.com/developers/alerts/
//
// Resolution model: an alert disappearing from activeonly=true means CTA
// considers it cleared. The bin schedules a threaded resolution reply on the
// next tick that doesn't see it.

const axios = require('axios');
const { withRetry } = require('./retry');

const BASE = 'http://lapi.transitchicago.com/api/1.0/alerts.aspx';

const RAIL_ROUTE_TO_LINE = {
  Red: 'red',
  Blue: 'blue',
  Brn: 'brn',
  G: 'g',
  Org: 'org',
  P: 'p',
  Pink: 'pink',
  Y: 'y',
};
const LINE_TO_RAIL_ROUTE = Object.fromEntries(
  Object.entries(RAIL_ROUTE_TO_LINE).map(([k, v]) => [v, k]),
);

async function fetchAlerts({ activeOnly = true, routeid = null } = {}) {
  const params = { outputType: 'JSON' };
  if (activeOnly) params.activeonly = 'true';
  if (routeid) params.routeid = routeid;
  const { data } = await withRetry(() => axios.get(BASE, { params, timeout: 15000 }), {
    label: 'CTA alerts',
  });
  return parseAlerts(data);
}

function parseAlerts(data) {
  // CTAAlerts.Alert is missing when zero, an object when one, an array otherwise.
  const raw = data?.CTAAlerts?.Alert;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map(normalizeAlert).filter(Boolean);
}

function normalizeAlert(raw) {
  if (!raw?.AlertId) return null;
  const impactedRaw = raw.ImpactedService?.Service;
  const services = Array.isArray(impactedRaw) ? impactedRaw : impactedRaw ? [impactedRaw] : [];
  const busRoutes = [];
  const trainLines = [];
  for (const s of services) {
    if (!s) continue;
    if (s.ServiceType === 'B' && s.ServiceId) busRoutes.push(String(s.ServiceId));
    if (s.ServiceType === 'R' && s.ServiceId) {
      const mapped = RAIL_ROUTE_TO_LINE[s.ServiceId];
      if (mapped) trainLines.push(mapped);
      else console.warn(`Unknown rail ServiceId "${s.ServiceId}" on alert ${raw.AlertId}`);
    }
  }
  return {
    id: String(raw.AlertId),
    headline: cleanText(raw.Headline),
    shortDescription: cleanText(raw.ShortDescription),
    fullDescription: cleanText(raw.FullDescription),
    major: raw.MajorAlert === '1' || raw.MajorAlert === 1 || raw.MajorAlert === true,
    severityScore: raw.SeverityScore != null ? parseInt(raw.SeverityScore, 10) : null,
    severityColor: raw.SeverityColor || null,
    eventStart: raw.EventStart ? parseCtaDate(raw.EventStart) : null,
    eventEnd: raw.EventEnd ? parseCtaDate(raw.EventEnd) : null,
    busRoutes,
    trainLines,
    url: raw.AlertURL?.['#cdata-section'] ? raw.AlertURL['#cdata-section'] : raw.AlertURL || null,
  };
}

const NAMED_ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function cleanText(s) {
  if (s == null) return null;
  let str = typeof s === 'string' ? s : s['#cdata-section'] || s.toString();
  str = str.replace(/<[^>]+>/g, ' ');
  str = str.replace(/&[a-z]+;/gi, (m) =>
    m.toLowerCase() in NAMED_ENTITIES ? NAMED_ENTITIES[m.toLowerCase()] : m,
  );
  str = str.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
  str = str.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  return str.replace(/\s+/g, ' ').trim();
}

// Feed dates may arrive as ISO 8601 ("2026-04-26T06:00:00") or legacy compact
// ("20260426 06:00:00") — both as America/Chicago wall time. Try DST and
// standard offsets and pick the one that round-trips back to the same wall
// time. Returns null on parse failure (no silently-wrong fallback).
function parseCtaDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const h = +m[4];
  const mi = +m[5];
  const se = +m[6];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  for (const offsetHours of [5, 6]) {
    const candidate = asUtc + offsetHours * 3600 * 1000;
    if (matchesChicagoWallTime(candidate, y, mo, d, h)) return candidate;
  }
  return null;
}

function matchesChicagoWallTime(ms, y, mo, d, h) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  return get('year') === y && get('month') === mo && get('day') === d && get('hour') % 24 === h;
}

const BETWEEN_PATTERNS = [
  /\bbetween\s+([A-Z][A-Za-z0-9./&\- ]+?)\s+and\s+([A-Z][A-Za-z0-9./&\- ]+?)(?:[.,;]| stations?\b| on\b| due\b| while\b)/i,
  /\bfrom\s+([A-Z][A-Za-z0-9./&\- ]+?)\s+to\s+([A-Z][A-Za-z0-9./&\- ]+?)(?:[.,;]| stations?\b| on\b| due\b| while\b)/i,
];

// Trailing word boundary deliberately omitted on the verb stems so "suspended",
// "shuttling", "halted", "closed" all match.
const DISRUPTION_ANCHORS = /\b(suspend|shuttl|halt|closed|no service|not running|no trains)/i;

function extractBetweenStations(text) {
  if (!text) return null;
  const matches = [];
  for (const re of BETWEEN_PATTERNS) {
    const reGlobal = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m = reGlobal.exec(text);
    while (m !== null) {
      matches.push({ from: m[1].trim(), to: m[2].trim(), index: m.index });
      m = reGlobal.exec(text);
    }
  }
  if (matches.length === 0) return null;
  const anchor = DISRUPTION_ANCHORS.exec(text);
  if (anchor) {
    matches.sort((a, b) => Math.abs(a.index - anchor.index) - Math.abs(b.index - anchor.index));
  }
  return { from: matches[0].from, to: matches[0].to };
}

// MajorAlert=1 alone is too noisy: CTA flags single-stop closures, block-party
// reroutes, and elevator outages as Major. Errs on silence — false negatives
// (miss a real outage) beat false positives (spam followers with stop closures).
const MIN_SEVERITY = 3;

const MAJOR_PATTERNS = [
  /\bno\s+(train|rail|bus|service)\b/i,
  /\bnot\s+running\b/i,
  /\bsuspended\b/i,
  /\bshuttle\s+bus(es)?\b/i,
  /\bmajor\s+delays?\b/i,
  /\bsignificant\s+delays?\b/i,
  /\bservice\s+(halted|disruption|impacted|impact)\b/i,
  /\bline\s+closed\b/i,
  /\bsingle[-\s]?track/i,
  /\bbetween\s+[A-Z][A-Za-z0-9./&\- ]+\s+and\s+[A-Z]/,
];

const MINOR_PATTERNS = [
  /\breroute[ds]?\b/i,
  /\bdetour/i,
  /\btemporar(y|ily)\b/i,
  /\bstop\s+(closed|closure|relocat)/i,
  // "bus stop" alone is too loose — the Yellow shuttle-substitution alert
  // mentions "bus stop" repeatedly to describe shuttle pickup locations.
  // Require "bus stop" to be paired with a minor-disruption verb.
  /\bbus\s+stop\s+(closed|closure|relocat|temporar|chang)/i,
  /\belevator\b/i,
  /\bescalator\b/i,
  /\bentrance\b/i,
  /\bauxiliary\s+entrance\b/i,
  /\bfare\s+machine\b/i,
  /\boverhead\s+wire\b/i,
  /\bpaint|painting\b/i,
  /\bconstruction\s+schedule\b/i,
  /\btrack\s+work\b/i, // scheduled engineering work — CTA posts separately as planned
  /\bweekend\s+service\s+change\b/i,
];

// Two admit paths after the minor-wins veto:
//   1. A MAJOR_PATTERN keyword match — strong textual signal of an actual
//      service disruption (suspended, shuttle bus, no trains, etc.). Admits
//      independent of MajorAlert/severity. This is what catches the Yellow
//      shuttle substitution (MajorAlert=0, sev=25) via "shuttle bus".
//   2. CTA's MajorAlert=1 flag combined with severity >= MIN_SEVERITY. The
//      flag alone is too noisy (single-stop closures get tagged Major); the
//      severity floor filters those down. Severity alone is also too noisy
//      — service-info posts ("Cubs night games extra service", "expanded
//      lakefront service") routinely score 9-12 without being disruptions.
//
// MINOR_PATTERNS only check headline + shortDescription. fullDescription is
// rich detail (shuttle pickup tables, station-entrance directions) and
// contains incidental matches for words like "entrance" or "bus stop" even
// on legitimate disruption alerts — checking the summary instead avoids
// vetoing real outages because their long-form text mentions stations.
function isSignificantAlert(alert) {
  if (!alert) return false;
  const summary = [alert.headline, alert.shortDescription].filter(Boolean).join(' \n ');
  const fullText = [alert.headline, alert.shortDescription, alert.fullDescription]
    .filter(Boolean)
    .join(' \n ');
  if (!summary && !fullText) return false;

  if (summary) {
    for (const re of MINOR_PATTERNS) if (re.test(summary)) return false;
  }
  for (const re of MAJOR_PATTERNS) if (re.test(fullText)) return true;
  if (alert.major && alert.severityScore != null && alert.severityScore >= MIN_SEVERITY) {
    return true;
  }
  return false;
}

module.exports = {
  fetchAlerts,
  parseAlerts,
  normalizeAlert,
  extractBetweenStations,
  isSignificantAlert,
  parseCtaDate,
  cleanText,
  MAJOR_PATTERNS,
  MINOR_PATTERNS,
  MIN_SEVERITY,
  RAIL_ROUTE_TO_LINE,
  LINE_TO_RAIL_ROUTE,
};
