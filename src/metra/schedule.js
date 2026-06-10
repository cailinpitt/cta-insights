// Metra schedule resolution: which trips are scheduled to run, and when, from
// the GTFS static index (data/metra-gtfs/index.json). The foundation for
// inferred-cancellation detection (Phase 2) and delay tracking (Phase 3) — both
// need to map a scheduled `trip_id` to a concrete wall-clock departure on a
// given service day. Pure (the index + `now` are injected) so it's unit-testable.
//
// GTFS service-day notes:
//   - A trip's stop times are seconds since *service-day* midnight, and can
//     exceed 86400 (a "25:30:00" owl trip departs 1:30 AM the next calendar day
//     but belongs to the prior service date). We therefore consider both today's
//     and yesterday's service dates so post-midnight trips resolve correctly.
//   - `service_id` activity is calendar.txt (day-of-week + date range) overlaid
//     with calendar_dates.txt exceptions (type 1 = added, 2 = removed).

const DAY_MS = 24 * 60 * 60 * 1000;

// 'YYYYMMDD' Chicago calendar date for an epoch ms.
function chicagoDateStr(ms) {
  // en-CA formats as YYYY-MM-DD.
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  return s.replace(/-/g, '');
}

// Epoch ms of 00:00 America/Chicago for a 'YYYYMMDD' date. Round-trips a UTC
// guess through the Chicago wall clock to recover the offset (same technique as
// parseBusTime in src/bus/api.js) so it's correct across DST without a tz lib.
function chicagoMidnightMs(dateStr) {
  const y = +dateStr.slice(0, 4);
  const mo = +dateStr.slice(4, 6);
  const da = +dateStr.slice(6, 8);
  const utcGuess = Date.UTC(y, mo - 1, da, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcGuess));
  const get = (k) => +parts.find((p) => p.type === k).value;
  const seenAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  const offset = utcGuess - seenAsUtc;
  return utcGuess + offset;
}

const DOW_INDEX = { Sun: 6, Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5 };

// 0 = Monday … 6 = Sunday, to index calendar.txt's day array
// [mon,tue,wed,thu,fri,sat,sun] for a 'YYYYMMDD' date (parsed as Chicago noon
// to dodge any DST edge at midnight).
function dayOfWeekIndex(dateStr) {
  const noon = chicagoMidnightMs(dateStr) + 12 * 60 * 60 * 1000;
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
  }).format(new Date(noon));
  return DOW_INDEX[wd];
}

// Set of service_ids active on a 'YYYYMMDD' date: calendar base (day-of-week +
// date range) ∪ calendar_dates additions − calendar_dates removals.
function activeServiceIds(index, dateStr) {
  const active = new Set();
  const dow = dayOfWeekIndex(dateStr);
  for (const [sid, cal] of Object.entries(index.calendar || {})) {
    if (!cal.days?.[dow]) continue;
    if (cal.start_date && dateStr < cal.start_date) continue;
    if (cal.end_date && dateStr > cal.end_date) continue;
    active.add(sid);
  }
  for (const ex of index.calendarDates || []) {
    if (ex.date !== dateStr) continue;
    if (ex.exception_type === 1) active.add(ex.service_id);
    else if (ex.exception_type === 2) active.delete(ex.service_id);
  }
  return active;
}

// The two service dates whose trips can be in progress "around now": today and
// yesterday (the latter covers owl trips with >24h stop times).
function candidateServiceDates(now = Date.now()) {
  return [chicagoDateStr(now), chicagoDateStr(now - DAY_MS)];
}

// Resolve every scheduled trip whose first-stop departure falls in [fromMs, toMs],
// across the candidate service dates. Returns one record per trip with a concrete
// `scheduledDepMs`, the origin/destination, and direction. Trips with no stop
// times are skipped (can't place them in time).
function scheduledDeparturesInWindow(index, fromMs, toMs, now = Date.now()) {
  const out = [];
  const seen = new Set(); // (tripId|serviceDate) guard against the two dates overlapping
  for (const dateStr of candidateServiceDates(now)) {
    const active = activeServiceIds(index, dateStr);
    const midnight = chicagoMidnightMs(dateStr);
    for (const [tripId, trip] of Object.entries(index.trips || {})) {
      if (!active.has(trip.service_id)) continue;
      const stops = trip.stop_times;
      if (!stops || stops.length === 0) continue;
      const depSec = stops[0].departure ?? stops[0].arrival;
      if (depSec == null) continue;
      const scheduledDepMs = midnight + depSec * 1000;
      if (scheduledDepMs < fromMs || scheduledDepMs > toMs) continue;
      const key = `${tripId}|${dateStr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const last = stops[stops.length - 1];
      out.push({
        tripId,
        route: trip.route_id,
        serviceDate: dateStr,
        scheduledDepMs,
        headsign: trip.headsign || null,
        originStopId: stops[0].stop_id,
        destStopId: last.stop_id,
        directionId: trip.direction_id,
      });
    }
  }
  return out;
}

module.exports = {
  chicagoDateStr,
  chicagoMidnightMs,
  dayOfWeekIndex,
  activeServiceIds,
  candidateServiceDates,
  scheduledDeparturesInWindow,
};
