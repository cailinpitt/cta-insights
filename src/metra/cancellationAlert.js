// Classify a Metra service alert as a *single-train cancellation* and resolve it
// to the concrete scheduled trip it annuls. This is what lets the alert lifecycle
// stop leaning on Metra's GTFS-rt feed (which leaves cancellations on the wire for
// hours past the train's moment, and drifts out of sync with metra.com) and
// instead anchor the event to the timetable: we know, the instant we parse the
// alert, exactly when that train was supposed to depart and arrive.
//
// A "single-train cancellation" is one we can pin to EXACTLY ONE scheduled trip.
// Open-ended notices ("no UP-N inbound service due to police activity") name no
// resolvable train and fall through to the existing ongoing→resolved model, where
// "resolved" genuinely means service was restored. Returns null for anything that
// isn't a resolvable single-train cancellation — the caller treats null as "use
// the old path".
//
// Pure: the index + `now` are injected, like src/metra/schedule.js. No feed, no DB.

const { ALL_LINES } = require('./lines');
const { chicagoMidnightMs, candidateServiceDates, activeServiceIds } = require('./schedule');

// Cancellation/annulment language. A significant alert that matches NONE of these
// (e.g. a qualified delay) is not a cancellation and is never finite-tracked here.
const CANCELLATION_PATTERNS = [
  /\bwill\s+not\s+operate\b/i,
  /\bcancell?ed\b/i,
  /\bcancellations?\b/i,
  /\bannull?ed\b/i,
  /\bnot\s+running\b/i,
];

function isCancellationText(text) {
  return CANCELLATION_PATTERNS.some((re) => re.test(text || ''));
}

// The run number embedded in a static Metra trip_id: `UP-W_UW67_V1_B` → "67",
// `MD-N_MN2145_V2_B` → "2145". The token after the route carries a letter prefix
// then the digits; routes themselves use hyphens (never underscores), so the run
// token is reliably the second underscore-delimited field.
function runNumberFromTripId(tripId) {
  if (tripId == null) return null;
  const parts = String(tripId).split('_');
  if (parts.length < 2) return null;
  const digits = parts[1].replace(/\D/g, '');
  return digits || null;
}

// Train numbers named in an alert header. Headers are terse and number-bearing
// ("UPW train #67 will not operate", "MDN 2145 - Will Not Operate", "MED Train
// #140 Annulled"), so we read numbers from the HEADER ONLY — the description
// carries scheduled clock times ("depart at 8:40 pm") that would pollute a digit
// scan. Prefer #-prefixed tokens; fall back to a bare 1–4 digit run when there's
// no #. Deduped, in order.
function extractTrainNumbers(header) {
  if (!header) return [];
  const out = [];
  const push = (n) => {
    if (n && !out.includes(n)) out.push(n);
  };
  const hashed = [...header.matchAll(/#(\d{1,4})\b/g)].map((m) => m[1]);
  if (hashed.length) {
    for (const n of hashed) push(n);
    return out;
  }
  for (const m of header.matchAll(/\b(\d{1,4})\b/g)) push(m[1]);
  return out;
}

// The single tracked route_id an alert is scoped to, or null if it touches zero or
// several. (A single-train cancellation is inherently one line.)
function soleRoute(alert) {
  const routes = [];
  for (const e of alert.informedEntities || []) {
    if (e.routeId && ALL_LINES.includes(e.routeId) && !routes.includes(e.routeId)) {
      routes.push(e.routeId);
    }
  }
  return routes.length === 1 ? routes[0] : null;
}

// Find the one scheduled trip on `route` whose run number is `trainNumber`, active
// on one of the candidate service dates. Returns the resolved trip with concrete
// wall-clock departure/arrival, or null if it resolves to zero or to genuinely
// different trips. The same logical train recurs across service-variant ids
// (A1/B1/E1/F1…) and across today/yesterday's candidate dates; those collapse on
// scheduled-departure ms, and when both calendar dates match (a daily train) we
// pick the instance nearest `now` — the one the alert is actually about.
function resolveScheduledTrip(index, route, trainNumber, now) {
  const matches = [];
  for (const dateStr of candidateServiceDates(now)) {
    const active = activeServiceIds(index, dateStr);
    const midnight = chicagoMidnightMs(dateStr);
    for (const [tripId, trip] of Object.entries(index.trips || {})) {
      if (trip.route_id !== route) continue;
      if (runNumberFromTripId(tripId) !== trainNumber) continue;
      if (!active.has(trip.service_id)) continue;
      const stops = trip.stop_times;
      if (!stops || stops.length === 0) continue;
      const depSec = stops[0].departure ?? stops[0].arrival;
      if (depSec == null) continue;
      const last = stops[stops.length - 1];
      const arrSec = last.arrival ?? last.departure ?? depSec;
      matches.push({
        tripId,
        route,
        serviceDate: dateStr,
        scheduledDepMs: midnight + depSec * 1000,
        scheduledArrMs: midnight + arrSec * 1000,
        originStopId: stops[0].stop_id,
        origin: index.stops?.[stops[0].stop_id]?.name || null,
        headsign: trip.headsign || null,
        directionId: trip.direction_id,
      });
    }
  }
  if (matches.length === 0) return null;
  // Collapse service-variant duplicates: same departure ms = same logical train.
  const byDep = new Map();
  for (const m of matches) if (!byDep.has(m.scheduledDepMs)) byDep.set(m.scheduledDepMs, m);
  const distinct = [...byDep.values()];
  if (distinct.length === 1) return distinct[0];
  // A daily train resolves on both candidate dates (~24h apart) — keep the
  // instance closest to now (the train the alert is about).
  distinct.sort((a, b) => Math.abs(a.scheduledDepMs - now) - Math.abs(b.scheduledDepMs - now));
  // Still ambiguous only if two distinct departures are both near now, which a
  // single run number on one route can't legitimately produce — treat as resolved
  // to the nearest rather than discarding a real cancellation.
  return distinct[0];
}

// Classify an alert. Returns a resolved single-train cancellation descriptor, or
// null when it isn't one (not a cancellation, no single route, no single train
// number, or unresolvable against the schedule index).
//   { route, trainNumber, tripId, serviceDate, scheduledDepMs, scheduledArrMs,
//     originStopId, origin }
function classifyCancellationAlert({ alert, index, now = Date.now() }) {
  if (!alert || !index) return null;
  const text = [alert.header, alert.description].filter(Boolean).join(' \n ');
  if (!isCancellationText(text)) return null;

  const route = soleRoute(alert);
  if (!route) return null;

  // Train number: header first; fall back to the run number on an informed-entity
  // trip_id when the header has none (the entity tripId, when present, is the most
  // authoritative — but its service-variant suffix may differ from the static
  // index, so we resolve by route+number, not by the raw id).
  let numbers = extractTrainNumbers(alert.header);
  if (numbers.length === 0) {
    const fromEntity = (alert.informedEntities || [])
      .map((e) => runNumberFromTripId(e.tripId))
      .filter(Boolean);
    numbers = [...new Set(fromEntity)];
  }
  if (numbers.length !== 1) return null; // zero, or a multi-train notice

  const resolved = resolveScheduledTrip(index, route, numbers[0], now);
  if (!resolved) return null;

  return {
    route,
    trainNumber: numbers[0],
    tripId: resolved.tripId,
    serviceDate: resolved.serviceDate,
    scheduledDepMs: resolved.scheduledDepMs,
    scheduledArrMs: resolved.scheduledArrMs,
    originStopId: resolved.originStopId,
    origin: resolved.origin,
    headsign: resolved.headsign,
    directionId: resolved.directionId,
  };
}

module.exports = {
  classifyCancellationAlert,
  isCancellationText,
  runNumberFromTripId,
  extractTrainNumbers,
  soleRoute,
  resolveScheduledTrip,
  CANCELLATION_PATTERNS,
};
