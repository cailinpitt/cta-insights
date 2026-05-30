// Docs: https://www.transitchicago.com/developers/alerts/
//
// Resolution model: an alert disappearing from activeonly=true means CTA
// considers it cleared. The bin schedules a threaded resolution reply on the
// next tick that doesn't see it.

const axios = require('axios');
const { withRetry } = require('./retry');
const trainStations = require('../train/data/trainStations.json');

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
    severityCss: raw.SeverityCSS ? String(raw.SeverityCSS).toLowerCase() : null,
    impact: raw.Impact ? String(raw.Impact) : null,
    eventStart: raw.EventStart ? parseCtaDate(raw.EventStart) : null,
    eventStartIsDateOnly: raw.EventStart ? isCtaDateOnly(raw.EventStart) : false,
    eventEnd: raw.EventEnd ? parseCtaDate(raw.EventEnd) : null,
    eventEndIsDateOnly: raw.EventEnd ? isCtaDateOnly(raw.EventEnd) : false,
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

// Feed dates may arrive as ISO 8601 ("2026-04-26T06:00:00"), legacy compact
// ("20260426 06:00:00"), or date-only ("2026-05-25") — all as America/Chicago
// wall time. Date-only values are interpreted as the end of that day
// (23:59:59 Chicago); CTA uses date-only EventEnd to mean "through this
// calendar day" rather than midnight at the start of it. Callers needing to
// distinguish date-only inputs (e.g. so the UI can render "Sun May 25"
// without a misleading 11:59 PM) should pair this with `isCtaDateOnly`.
// Returns null on parse failure (no silently-wrong fallback).
function parseCtaDate(s) {
  if (!s) return null;
  let y;
  let mo;
  let d;
  let h;
  let mi;
  let se;
  const full = /^(\d{4})-?(\d{2})-?(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (full) {
    y = +full[1];
    mo = +full[2];
    d = +full[3];
    h = +full[4];
    mi = +full[5];
    se = +full[6];
  } else {
    const dateOnly = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
    if (!dateOnly) return null;
    y = +dateOnly[1];
    mo = +dateOnly[2];
    d = +dateOnly[3];
    h = 23;
    mi = 59;
    se = 59;
  }
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  for (const offsetHours of [5, 6]) {
    const candidate = asUtc + offsetHours * 3600 * 1000;
    if (matchesChicagoWallTime(candidate, y, mo, d, h)) return candidate;
  }
  return null;
}

function isCtaDateOnly(s) {
  if (!s) return false;
  return /^\d{4}-?\d{2}-?\d{2}$/.test(String(s).trim());
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

// The trailing terminator group bounds the station-name captures. ` in\b`
// stops the capture before a trailing "in both/each direction(s)" clause
// (e.g. "...between Cermak-Chinatown and Fullerton in both directions") so the
// second endpoint resolves to "Fullerton", not "Fullerton in both directions".
// No CTA station name contains a space-delimited "in", so this can't truncate
// a real name mid-string.
// The capture groups start with [A-Z0-9] (not just [A-Z]): many CTA stations
// lead with a digit — 54th/Cermak, 95th/Dan Ryan, 63rd, 35th/Archer, 18th —
// so "between Pulaski and 54th/Cermak" must let the second endpoint begin with
// a number. Without the digit, every digit-initial endpoint silently failed to
// match and the alert carried no structured station fields at all.
const BETWEEN_PATTERNS = [
  /\bbetween\s+([A-Z0-9][A-Za-z0-9./&\- ]+?)\s+and\s+([A-Z0-9][A-Za-z0-9./&\- ]+?)(?:[.,;]| stations?\b| in\b| on\b| due\b| while\b)/i,
  /\bfrom\s+([A-Z0-9][A-Za-z0-9./&\- ]+?)\s+to\s+([A-Z0-9][A-Za-z0-9./&\- ]+?)(?:[.,;]| stations?\b| in\b| on\b| due\b| while\b)/i,
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

// Direction extraction.
//
// Convention: return one of 'north'|'south'|'east'|'west'|'in'|'out', or null.
// Chosen over speedmap's 'outbound'/'inbound' because (a) most lines are
// bidirectional with compass semantics, not in/out, and (b) `directionHint`
// only exists for round-trip lines (brn/org/pink/p) — using it as the universal
// vocabulary would be lossy for Red/Blue/Green/Yellow. Callers translating to
// `directionHint` can do so per-line.

// Per-line terminus → compass direction. Terminus names match station 'name'
// fields in trainStations.json (case-insensitive, base-name strip). When the
// alert says "toward Howard" on red, we resolve Howard → 'north'. Lines absent
// from this table fall back to the bare keyword path.
const TERMINUS_DIRECTION = {
  red: { howard: 'north', '95th/dan ryan': 'south', '95th': 'south' },
  blue: { "o'hare": 'north', ohare: 'north', 'forest park': 'west' },
  brn: { kimball: 'out', loop: 'in' },
  g: {
    'harlem/lake': 'west',
    harlem: 'west',
    'cottage grove': 'east',
    'ashland/63rd': 'south',
    ashland: 'south',
  },
  org: { midway: 'out', loop: 'in' },
  p: { linden: 'out', howard: 'in', loop: 'in' },
  pink: { '54th/cermak': 'out', cermak: 'out', loop: 'in' },
  y: { 'dempster-skokie': 'north', dempster: 'north', howard: 'south' },
};

const COMPASS_KEYWORDS = [
  [/\bnorth(bound|\b)/i, 'north'],
  [/\bsouth(bound|\b)/i, 'south'],
  [/\beast(bound|\b)/i, 'east'],
  [/\bwest(bound|\b)/i, 'west'],
  [/\binbound\b/i, 'in'],
  [/\boutbound\b/i, 'out'],
];

// Capture group deliberately excludes '.' so "toward 95th." stops at the dot
// (lookahead). Numbers permitted because terminus names like "95th" / "54th".
const TOWARD_RE = /\btoward(s)?\s+([A-Za-z0-9/&' -]+?)(?=[.,;]|\bon\b|\bdue\b|$)/i;

// "single-tracking near X" alone (no compass word) is bidirectional from the
// alert-bot's perspective — we explicitly don't infer a direction.
function extractDirection(text, line = null) {
  if (!text) return null;
  for (const [re, dir] of COMPASS_KEYWORDS) {
    if (re.test(text)) return dir;
  }
  const m = TOWARD_RE.exec(text);
  if (m && line) {
    const terminus = m[2].trim().toLowerCase().replace(/\s+/g, ' ');
    const table = TERMINUS_DIRECTION[line];
    if (table) {
      if (terminus in table) return table[terminus];
      // try base-name strip (drop parenthetical line tag)
      const base = terminus.split(' (')[0].trim();
      if (base in table) return table[base];
    }
  }
  return null;
}

// Match station name candidates appearing in an *impact* context — verbs that
// describe where service is degraded ("delays at Monroe", "standing at UIC
// Halsted", "near Adams/Wabash"). Direction phrasing ("O'Hare-bound", "toward
// 95th", "to Howard") never uses these anchors, so terminus mentions used
// only to indicate train direction don't get captured. Capture group runs
// until punctuation or a follow-on clause keyword (due, because, while, …).
// Leading [A-Z0-9] (not just [A-Z]): digit-initial stations like 54th/Cermak
// or 95th/Dan Ryan appear in impact phrasing too ("standing at 54th/Cermak").
// Junk captures ("at 5 PM") are harmless — resolveStationOnLine drops anything
// that isn't a real station on the line.
const IMPACT_CONTEXT_RE =
  /\b(?:at|near)\s+([A-Z0-9][A-Za-z0-9./&\-()' ]+?)(?=\s*[.,;!]|\s+(?:due|because|while|after|following|crews|station|stations|stop|stops|toward|with)\b|$)/g;

function normalizeStationKey(s) {
  return (
    String(s)
      .toLowerCase()
      // collapse whitespace around slashes ("Adams/ Wabash" → "adams/wabash")
      .replace(/\s*\/\s*/g, '/')
      // unify hyphens-as-separator with spaces ("UIC-Halsted" ↔ "UIC Halsted")
      .replace(/[\s-]+/g, ' ')
      .trim()
  );
}

// Map the colloquial / legacy branch labels CTA still uses inside its
// parenthetical disambiguators to a substring that will appear in the roster's
// canonical branch label. CTA writes "Western(Congress)" — the Forest Park
// branch's pre-2026 name — but our roster carries "Western (Blue - Forest
// Park Branch)". Without this map a same-base, two-branch station like
// Western (Blue) is unresolvable from CTA's text. Keys are lowercase, values
// are matched as substrings against the roster's parenthetical (also
// lowercased), so partial matches like 'forest park' → 'blue - forest park
// branch' work without enumerating every roster string.
const BRANCH_ALIASES = {
  congress: 'forest park',
  ohare: 'ohare',
  "o'hare": 'ohare',
};

// Resolve a free-text station mention to a canonical name from the roster,
// scoped to the alert's line so "Halsted" on Orange doesn't bleed into Blue.
// Tiered: exact (normalized) → base name without parenthetical disambiguator
// → base + branch-alias hint pulled from a parenthetical the candidate
// carries (Western(Congress) → Western on Blue with branch matching 'forest
// park'). Returns the canonical station name or null.
function resolveStationOnLine(candidate, line, stations = trainStations) {
  if (!candidate || !line) return null;
  const target = normalizeStationKey(candidate);
  if (!target) return null;
  const onLine = stations.filter((s) => s.lines?.includes(line));
  for (const s of onLine) {
    if (normalizeStationKey(s.name) === target) return s.name;
  }
  for (const s of onLine) {
    const base = s.name.split(' (')[0];
    if (normalizeStationKey(base) === target) return s.name;
  }
  // Branch-alias tier: peel "Western(Congress)" into base="western" + hint
  // "congress", translate the hint via BRANCH_ALIASES, and pick the on-line
  // station whose canonical parenthetical contains the translated hint.
  const parenMatch = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(candidate);
  if (parenMatch) {
    const baseTarget = normalizeStationKey(parenMatch[1]);
    const hintRaw = parenMatch[2]
      .toLowerCase()
      .replace(/[\s-]+/g, '')
      .replace(/branch$/, '');
    const hint = BRANCH_ALIASES[hintRaw] ?? hintRaw;
    if (baseTarget && hint) {
      // Strip non-alphanumerics on both sides so "o'hare" matches "ohare"
      // and "forest park" matches "forestpark"; the substring check is
      // forgiving without enumerating apostrophe/space variants.
      const flatten = (str) => str.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const flatHint = flatten(hint);
      for (const s of onLine) {
        const sParen = /\(([^)]+)\)/.exec(s.name);
        if (!sParen) continue;
        const sBase = s.name.split(' (')[0];
        if (normalizeStationKey(sBase) !== baseTarget) continue;
        if (flatten(sParen[1]).includes(flatHint)) return s.name;
      }
    }
  }
  return null;
}

// Extract the canonical names of stations the alert text says are impacted.
// Combines impact-context matches ("at X", "near X") with the existing
// between/from-to segment endpoints. Caller passes the alert's single line so
// resolution can disambiguate same-named stations (Western Blue vs Western
// Brown). Returns a deduplicated array; empty when nothing resolves.
function extractMentionedStations(text, line, stations = trainStations) {
  if (!text || !line) return [];
  const seen = new Set();
  const out = [];
  const add = (canonical) => {
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    out.push(canonical);
  };

  IMPACT_CONTEXT_RE.lastIndex = 0;
  let m = IMPACT_CONTEXT_RE.exec(text);
  while (m !== null) {
    add(resolveStationOnLine(m[1], line, stations));
    m = IMPACT_CONTEXT_RE.exec(text);
  }

  const between = extractBetweenStations(text);
  if (between) {
    add(resolveStationOnLine(between.from, line, stations));
    add(resolveStationOnLine(between.to, line, stations));
  }
  return out;
}

// MajorAlert=1 alone is too noisy: CTA flags single-stop closures, block-party
// reroutes, and elevator outages as Major. Errs on silence — false negatives
// (miss a real outage) beat false positives (spam followers with stop closures).
const MIN_SEVERITY = 3;

// CTA's own `Impact` classification is the most reliable categorization in
// the feed payload — every alert is tagged with one of ~11 stable buckets
// ("Bus Stop Note", "Planned Reroute", "Elevator Status", "Minor Delays",
// "Significant Delays", "Major Delays", etc.). When the Impact bucket
// explicitly classifies the alert as a significant or major service
// disruption, trust that — even if the headline phrasing doesn't trigger a
// MAJOR_PATTERN match and MajorAlert=0. This caught the 2026-05-13 Red Line
// police-activity hold at Sox-35th (AlertId 114905, Impact="Significant
// Delays", headline "Service Delayed", MajorAlert=0, severityCss=minor —
// every other admit path missed it).
const SIGNIFICANT_IMPACTS = new Set(['Significant Delays', 'Major Delays']);

// "Reroute"/"detour" alone is too noisy (most are local block-party detours,
// hence the MINOR_PATTERNS veto), but two reroute shapes ARE worth posting:
//
//   1. **Multi-route reroutes** — when 3+ routes are diverted simultaneously,
//      it's almost always a structural event (CPD funeral, parade, marathon,
//      large road closure). Single- and two-route reroutes are usually local
//      and noisy.
//   2. **High-severity reroutes** — CTA's default SeverityScore for reroutes
//      is 37; anything ≥50 is rare and only fires for things they consider
//      acutely disruptive (police activity, crash, fire, hazmat). Catches
//      single-route incidents that ARE worth posting.
//
// Both numbers are calibrated against the live feed (see docs/ALERTS.md);
// adjust there if the feed's severity defaults shift.
const REROUTE_RE = /\b(reroute[ds]?|detour)\b/i;
const MULTI_ROUTE_THRESHOLD = 3;
const HIGH_SEVERITY_THRESHOLD = 50;
// Multi-route reroutes spanning a week or more are construction notices, not
// breaking news — CTA leaves them on the feed for the entire window and
// affected riders have already adjusted by the time the bot picks them up.
// Two real cases we caught this way: a 6-week SB State construction reroute
// (8 routes) and a week-long bus-terminal stop relocation at Pulaski (3
// routes). High-severity admits still apply: a sev-50+ reroute is an acute
// event regardless of declared duration.
const LONG_PLANNED_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// A named station-to-station segment ("between X and Y"). Strong signal that
// an alert is segment-scoped service disruption rather than a local blip;
// reused below to admit rail reroutes that name the rerouted segment.
const BETWEEN_MAJOR_RE = /\bbetween\s+[A-Z][A-Za-z0-9./&\- ]+\s+and\s+[A-Z]/;

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
  BETWEEN_MAJOR_RE,
];

// A precise (non-date-only) event window shorter than the long-planned
// cutoff, or no usable window at all. Long multi-day/week planned
// construction sits on the feed for its full duration and is filtered after
// day 1; unknown/date-only duration admits conservatively (treated as short),
// matching the prior strict-parser behavior so we don't retroactively drop
// alerts that used to admit.
function isWithinPlannedWindow(alert) {
  const hasPreciseWindow =
    alert.eventStart != null &&
    alert.eventEnd != null &&
    !alert.eventStartIsDateOnly &&
    !alert.eventEndIsDateOnly;
  const duration = hasPreciseWindow ? alert.eventEnd - alert.eventStart : null;
  return duration == null || duration < LONG_PLANNED_DURATION_MS;
}

const MINOR_PATTERNS = [
  /\breroute[ds]?\b/i,
  /\bdetour/i,
  /\btemporar(y|ily)\b/i,
  /\bstop\s+(closed|closure|relocat)/i,
  // "bus stop" alone is too loose — the Yellow shuttle-substitution alert
  // mentions "bus stop" repeatedly to describe shuttle pickup locations.
  // Require "bus stop" to be paired with a minor-disruption verb.
  /\bbus\s+stop\s+(closed|closure|relocat|temporar|chang)/i,
  // "Boarding Change" alerts cover platform/track-side shuffles where trains
  // share a track but service still runs.
  /\bboarding\s+change/i,
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

  // Reroute admit-overrides — run BEFORE the MINOR veto so reroutes affecting
  // many routes (structural) or flagged with elevated severity (acute
  // incident) are admitted even though "reroute" alone normally vetoes.
  if (REROUTE_RE.test(summary)) {
    // High-severity wins outright — sev≥50 reroutes are acute events
    // (police activity, crash) regardless of declared duration. But CTA
    // sometimes assigns sev=55 to routine street-blockage reroutes while
    // simultaneously tagging them `SeverityCSS=minor` / `Impact=Minor Delays /
    // Reroute` in the same feed payload. Trust CTA's own classification when
    // it disagrees with the score: if CTA itself calls it minor, it isn't an
    // acute incident regardless of the numeric severity.
    if (
      alert.severityScore != null &&
      alert.severityScore >= HIGH_SEVERITY_THRESHOLD &&
      alert.severityCss !== 'minor'
    ) {
      return true;
    }
    const routeCount = (alert.busRoutes?.length || 0) + (alert.trainLines?.length || 0);
    // ...except long-duration planned reroutes — multi-route construction
    // notices that sit on the feed for weeks (see isWithinPlannedWindow).
    if (routeCount >= MULTI_ROUTE_THRESHOLD && isWithinPlannedWindow(alert)) {
      return true;
    }

    // Rail segment reroutes — a reroute on a train line that names a
    // station-to-station segment ("rerouted ... between Cermak-Chinatown and
    // Fullerton") is a real, line-wide service change (subway→elevated track
    // swaps, weekend segment reroutes), not a local block-party detour. The
    // `between X and Y` signal is already a MAJOR_PATTERN, but the minor-wins
    // veto below would reject it on the "reroute" keyword before the MAJOR
    // check runs. Admit here, gated on the reroute keyword (we're inside the
    // REROUTE_RE branch) + a train line + the named segment, subject to the
    // same long-planned cutoff so multi-week rail construction still drops.
    // Bus-only block-party detours are unaffected (no train line). AlertId
    // 114934 (2026-05-29) was the missed case: single-route Red reroute, sev
    // 36, that 114904's near-identical bus-substitution sibling admitted only
    // because it lacked the "reroute" keyword.
    if (
      alert.trainLines?.length &&
      BETWEEN_MAJOR_RE.test(fullText) &&
      isWithinPlannedWindow(alert)
    ) {
      return true;
    }
  }

  // Trust CTA's Impact classification when it explicitly buckets the alert
  // as a significant/major delay. Goes before the MINOR_PATTERNS veto so
  // an admit-worthy alert whose body happens to mention "elevator" or
  // "boarding change" still goes through — Impact is the most reliable
  // semantic signal in the feed.
  if (alert.impact && SIGNIFICANT_IMPACTS.has(alert.impact)) return true;

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
  extractMentionedStations,
  resolveStationOnLine,
  extractDirection,
  isSignificantAlert,
  parseCtaDate,
  isCtaDateOnly,
  cleanText,
  MAJOR_PATTERNS,
  MINOR_PATTERNS,
  MIN_SEVERITY,
  MULTI_ROUTE_THRESHOLD,
  HIGH_SEVERITY_THRESHOLD,
  RAIL_ROUTE_TO_LINE,
  LINE_TO_RAIL_ROUTE,
};
