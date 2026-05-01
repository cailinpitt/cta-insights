const { names: routeNames } = require('./routes');
const { formatCallouts } = require('../shared/history');
const { formatDistance, formatMinSec, elapsedMinutesLabel } = require('../shared/format');

function routeTitle(route) {
  const name = routeNames[route];
  return name ? `Route ${route} (${name})` : `Route ${route}`;
}

function buildPostText(bunch, pattern, stop, callouts = [], opts = {}) {
  const title = routeTitle(bunch.route);
  const vids = bunch.vehicles
    .map((v) => `#${v.vid}`)
    .filter((s) => s !== '#undefined')
    .join(', ');
  const busesLine = vids ? `\nBuses: ${vids}` : '';
  const lead = opts.networkRecord ? '🏆 CTA BUS BUNCHING RECORD 🏆\n' : '';
  const base = `${lead}🚌 ${title} — ${pattern.direction}\n${bunch.vehicles.length} buses within ${formatDistance(bunch.spanFt)} near ${stop.stopName}${busesLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
}

function buildAltText(bunch, pattern, stop, opts = {}) {
  const intro = opts.networkRecord
    ? 'Map of the current CTA-wide 30-day bus bunching record: '
    : 'Map of ';
  return `${intro}${routeTitle(bunch.route)} near ${stop.stopName} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses within ${formatDistance(bunch.spanFt)} of each other.`;
}

function buildVideoPostText(result, bunch, pattern) {
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  const context = bunch && pattern ? `${routeTitle(bunch.route)} — ${pattern.direction}\n` : '';
  if (result.finalSpanFt == null)
    return `${context}Timelapse of the above — ${elapsed} of real time.`;
  const delta = result.finalSpanFt - result.initialSpanFt;
  let headline;
  if (delta > 50)
    headline = `${elapsed} later, the buses were ${formatDistance(delta)} farther apart.`;
  else if (delta < -50)
    headline = `${elapsed} later, the gap had closed by ${formatDistance(-delta)}.`;
  else headline = `Still bunched ${elapsed} later.`;
  return `${context}${headline}\n🎬 ${formatDistance(result.initialSpanFt)} → ${formatDistance(result.finalSpanFt)}`;
}

function buildVideoAltText(bunch, pattern, stop, result, opts = {}) {
  const badge = opts.networkRecord ? ' with a CTA Bus Bunching Record overlay' : '';
  return `Timelapse map of ${routeTitle(bunch.route)} near ${stop.stopName}${badge} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses moving over ${formatMinSec(result.elapsedSec)}.`;
}

module.exports = { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText };
