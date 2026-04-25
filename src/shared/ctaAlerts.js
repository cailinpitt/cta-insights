// Docs: https://www.transitchicago.com/developers/alerts/
//
// Resolution model: an alert disappearing from activeonly=true means CTA
// considers it cleared. The bin schedules a threaded resolution reply on the
// next tick that doesn't see it.

const axios = require('axios');
const { withRetry } = require('./retry');

const BASE = 'http://lapi.transitchicago.com/api/1.0/alerts.aspx';

const RAIL_ROUTE_TO_LINE = {
  Red: 'red', Blue: 'blue', Brn: 'brn', G: 'g',
  Org: 'org', P: 'p', Pink: 'pink', Y: 'y',
};

async function fetchAlerts({ activeOnly = true, routeid = null } = {}) {
  const params = { outputType: 'JSON' };
  if (activeOnly) params.activeonly = 'true';
  if (routeid) params.routeid = routeid;
  const { data } = await withRetry(() => axios.get(BASE, { params, timeout: 15000 }),
    { label: 'CTA alerts' });
  return parseAlerts(data);
}

function parseAlerts(data) {
  // CTAAlerts.Alert is missing when zero, an object when one, an array otherwise.
  const raw = data && data.CTAAlerts && data.CTAAlerts.Alert;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map(normalizeAlert).filter(Boolean);
}

function normalizeAlert(raw) {
  if (!raw || !raw.AlertId) return null;
  const impactedRaw = raw.ImpactedService && raw.ImpactedService.Service;
  const services = Array.isArray(impactedRaw) ? impactedRaw : impactedRaw ? [impactedRaw] : [];
  const busRoutes = [];
  const trainLines = [];
  for (const s of services) {
    if (!s) continue;
    if (s.ServiceType === 'B' && s.ServiceId) busRoutes.push(String(s.ServiceId));
    if (s.ServiceType === 'R' && s.ServiceId && RAIL_ROUTE_TO_LINE[s.ServiceId]) {
      trainLines.push(RAIL_ROUTE_TO_LINE[s.ServiceId]);
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
    url: raw.AlertURL && raw.AlertURL['#cdata-section'] ? raw.AlertURL['#cdata-section'] : (raw.AlertURL || null),
  };
}

function cleanText(s) {
  if (s == null) return null;
  const str = typeof s === 'string' ? s : (s['#cdata-section'] || s.toString());
  return str.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// CTA returns dates like "20260424 12:45:00" as America/Chicago wall time.
function parseCtaDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  // Try both possible CT offsets (DST: -5, standard: -6) — pick the one that
  // round-trips to the same wall time in America/Chicago.
  for (const offsetHours of [5, 6]) {
    const candidate = asUtc + offsetHours * 3600 * 1000;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(candidate));
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    if (get('year') === +y && get('month') === +mo && get('day') === +d && get('hour') === +h) {
      return candidate;
    }
  }
  return asUtc;
}

// Returns { from, to } or null. Caller falls back to text-only when null.
const BETWEEN_PATTERNS = [
  /\bbetween\s+([A-Z][A-Za-z0-9./&\- ]+?)\s+and\s+([A-Z][A-Za-z0-9./&\- ]+?)(?:[.,;]| stations?\b| on\b| due\b| while\b)/,
  /\bfrom\s+([A-Z][A-Za-z0-9./&\- ]+?)\s+to\s+([A-Z][A-Za-z0-9./&\- ]+?)(?:[.,;]| stations?\b| on\b| due\b| while\b)/,
];
function extractBetweenStations(text) {
  if (!text) return null;
  for (const re of BETWEEN_PATTERNS) {
    const m = re.exec(text);
    if (m) return { from: m[1].trim(), to: m[2].trim() };
  }
  return null;
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
  /\bbus\s+stop\b/i,
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

function isSignificantAlert(alert) {
  if (!alert || !alert.major) return false;
  const text = [alert.headline, alert.shortDescription, alert.fullDescription]
    .filter(Boolean).join(' \n ');
  if (!text) return false;

  // Minor-wins: "No trains stopping at Belmont (elevator construction)" looks
  // major by headline alone but should drop on the elevator keyword.
  for (const re of MINOR_PATTERNS) if (re.test(text)) return false;
  for (const re of MAJOR_PATTERNS) if (re.test(text)) return true;
  if (alert.severityScore != null && alert.severityScore >= MIN_SEVERITY) return true;
  return false;
}

module.exports = {
  fetchAlerts,
  parseAlerts,
  normalizeAlert,
  extractBetweenStations,
  isSignificantAlert,
  MAJOR_PATTERNS,
  MINOR_PATTERNS,
  MIN_SEVERITY,
  RAIL_ROUTE_TO_LINE,
};
