const { names: routeNames } = require('./routes');
const { formatCallouts } = require('../shared/history');
const { formatMinutes, formatDistance, elapsedMinutesLabel } = require('../shared/format');

function routeTitle(route) {
  const name = routeNames[route];
  return name ? `Route ${route} (${name})` : `Route ${route}`;
}

function buildPostText(gap, pattern, stop, callouts = []) {
  // `leading` is the bus already past the gap (last seen); `trailing` is the
  // next one a rider is waiting for. "(last)/(next)" read as ambiguous, so spell
  // the rider roles out — the map tags the two discs L/N to match.
  const lastSeen = gap.leading?.vid ? `#${gap.leading.vid}` : null;
  const nextUp = gap.trailing?.vid ? `#${gap.trailing.vid}` : null;
  const busesLine =
    lastSeen || nextUp
      ? `\n\n${[lastSeen && `Last seen: ${lastSeen}`, nextUp && `Next up: ${nextUp}`].filter(Boolean).join(' · ')}`
      : '';
  // Lead with the lived effect — "No bus for ~24 min" reads as the service hole
  // a rider is sitting in, not an abstract "gap." Tilde: it's a distance/speed
  // estimate, not a measured ETA.
  const base = `🕳️ ${routeTitle(gap.route)} — ${pattern.direction}\n\nNo bus near ${stop.stopName} for ~${formatMinutes(gap.gapMin)} — scheduled around every ${formatMinutes(gap.expectedMin)} this hour${busesLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(gap, pattern, stop) {
  return `Map of ${routeTitle(gap.route)} ${pattern.direction.toLowerCase()} showing a ${formatMinutes(gap.gapMin)} gap between buses near ${stop.stopName}.`;
}

// Timelapse reply text. Leads with the full effect — how long the route has
// gone without a bus — then the next bus's progress toward the stop, so the
// "next bus ~N min" half doesn't undersell a gap whose first half already
// elapsed.
function buildGapVideoPostText(gap, result) {
  const stop = result.stopName || 'the stop';
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  const lead = `${routeTitle(gap.route)} hasn't had a bus in ~${result.gapMin} min.`;
  if (result.reached) {
    return `${lead} ${elapsed} later, the next one reached ${stop}.`;
  }
  return `${lead} ${elapsed} later, the next one had closed to ${formatDistance(result.endDistFt)} from ${stop}.`;
}

function buildGapVideoAltText(gap, pattern, result) {
  const stop = result.stopName || 'the stop';
  return `Timelapse map of ${routeTitle(gap.route)} ${pattern.direction.toLowerCase()} showing the next bus approaching ${stop} over ${formatMinutes(result.elapsedSec / 60)}.`;
}

module.exports = { buildPostText, buildAltText, buildGapVideoPostText, buildGapVideoAltText };
