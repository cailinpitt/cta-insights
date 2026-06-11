// Classify a Metra service alert as a *single-train delay* and anchor its end to
// the timetable. The delay analog of src/metra/cancellationAlert.js: it lets the
// alert lifecycle stop waiting on Metra's GTFS-rt feed (which leaves a delay on the
// wire for hours past the train's moment) and instead resolve the event the moment
// the train should have finished its run — its final scheduled arrival plus the
// announced delay, plus a small grace buffer for delays that creep upward.
//
// A "single-train delay" is one we can pin to EXACTLY ONE scheduled trip AND that
// carries a concrete delay magnitude ("25 to 35 minutes behind schedule"). We don't
// parse the clock time out of the prose — the GTFS index gives us the trip's real
// final arrival; the text only has to yield the delay magnitude and the train. A
// bare "expect delays" notice (no magnitude) or a system-wide advisory names no
// resolvable single train and falls through to the existing feed-drop model.
// Returns null for anything that isn't a resolvable single-train delay — the caller
// treats null as "use the old path".
//
// Pure: the index + `now` are injected, like src/metra/cancellationAlert.js.

const {
  isCancellationText,
  soleRoute,
  runNumberFromTripId,
  resolveScheduledTrip,
} = require('./cancellationAlert');

// Grace past (scheduled arrival + announced delay) before we infer the train has
// finished. Delays are live estimates that sometimes grow, so we wait a little
// beyond the announced late-arrival time rather than resolving the instant it
// elapses — still hours earlier than Metra typically clears the alert.
const DELAY_RESOLVE_GRACE_MS = 15 * 60 * 1000;

// Largest delay magnitude (in minutes) the text states, or null if none. Reads the
// number immediately preceding "minute(s) late/behind/delay", so a range like
// "25 to 35 minutes behind schedule" yields 35 (only "35 minutes behind" is
// adjacent to the unit), and "20+ minutes late" / "20 or more minutes late" yield
// 20. A bare "minor delays" (no magnitude) yields null — intentionally not finite-
// tracked. Max across all matches so the worst stated figure wins.
function parseMaxDelayMinutes(text) {
  if (!text) return null;
  const re = /(\d{1,3})\s*(?:\+|\s*or\s+more)?\s*minutes?\s+(?:late|behind|delay)/gi;
  let max = null;
  for (const m of text.matchAll(re)) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && (max == null || n > max)) max = n;
  }
  return max;
}

// Train numbers named in a delay alert. Unlike a cancellation header (terse and
// number-bearing), a delay alert states magnitudes and clock times in prose, so a
// bare digit scan would pick up "35 minutes" or "1:08". We therefore read ONLY
// numbers anchored to the word "train" ("Train 31", "UPW train #50"), across header
// AND description (Metra puts the run number in either). Deduped, in order.
function trainNumbersFromText(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(/\btrain\s+#?(\d{1,4})\b/gi)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function delayText(alert) {
  return [alert.header, alert.description].filter(Boolean).join(' \n ');
}

// Classify an alert. Returns a resolved single-train delay descriptor, or null when
// it isn't one (a cancellation, no stated magnitude, no single route, no single
// train number, or unresolvable against the schedule index).
//   { route, trainNumber, tripId, serviceDate, scheduledArrMs, maxDelayMin,
//     deadlineMs, origin, headsign }
function classifyDelayAlert({ alert, index, now = Date.now() }) {
  if (!alert || !index) return null;
  const text = delayText(alert);
  // Cancellations own their own schedule-anchored path; never double-track.
  if (isCancellationText(text)) return null;

  const maxDelayMin = parseMaxDelayMinutes(text);
  if (maxDelayMin == null) return null;

  const route = soleRoute(alert);
  if (!route) return null;

  // Train number: the run number on an informed-entity trip_id is most
  // authoritative; fall back to a "train #N" mention in the text.
  const fromEntity = [
    ...new Set(
      (alert.informedEntities || []).map((e) => runNumberFromTripId(e.tripId)).filter(Boolean),
    ),
  ];
  const numbers = fromEntity.length ? fromEntity : trainNumbersFromText(text);
  if (numbers.length !== 1) return null; // zero, or a multi-train notice

  const resolved = resolveScheduledTrip(index, route, numbers[0], now);
  if (!resolved) return null;

  return {
    route,
    trainNumber: numbers[0],
    tripId: resolved.tripId,
    serviceDate: resolved.serviceDate,
    scheduledArrMs: resolved.scheduledArrMs,
    maxDelayMin,
    deadlineMs: resolved.scheduledArrMs + maxDelayMin * 60 * 1000 + DELAY_RESOLVE_GRACE_MS,
    origin: resolved.origin,
    headsign: resolved.headsign,
  };
}

module.exports = {
  classifyDelayAlert,
  parseMaxDelayMinutes,
  trainNumbersFromText,
  DELAY_RESOLVE_GRACE_MS,
};
