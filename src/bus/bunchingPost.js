const { names: routeNames } = require('./routes');
const { assignBusNumbers } = require('./bunching');
const { formatCallouts } = require('../shared/history');
const { formatDistance, formatMinSec, elapsedMinutesLabel } = require('../shared/format');

function routeTitle(route) {
  const name = routeNames[route];
  return name ? `Route ${route} (${name})` : `Route ${route}`;
}

function buildPostText(bunch, pattern, stop, callouts = [], opts = {}) {
  const title = routeTitle(bunch.route);
  // Tag each run with the identity number it carries on the map/video so a
  // reader can tie a numbered disc back to its bus. Listed in number order
  // (1 = lead bus) so the parenthetical reads 1, 2, 3… down the line.
  const labels = assignBusNumbers(bunch.vehicles);
  const vids = bunch.vehicles
    .filter((v) => v.vid != null)
    .map((v) => ({ label: `#${v.vid}`, n: labels.get(v.vid) }))
    .sort((a, b) => a.n - b.n)
    .map((x) => `${x.label} (${x.n})`)
    .join(', ');
  const busesLine = vids ? `\n\nBuses: ${vids}` : '';
  // 🥇 medal line when this bunch sets a new record for most buses ever seen
  // bunched on any route. Sits above the buses listing so the medal headlines
  // the post.
  const recordLine = opts.isAllTimeRecord
    ? `\n\n🥇 New record: most buses ever bunched${
        opts.previousRecord != null ? ` (was ${opts.previousRecord})` : ''
      }`
    : '';
  // The gap the bunch leaves behind it is the rider-facing cost — the wait the
  // next person at the stop faces. Distance always; estimated minutes when a
  // scheduled pace is known.
  const gapLine = opts.gapBehind
    ? `\n\nNext bus ${formatDistance(opts.gapBehind.distFt)}${
        opts.gapBehind.minutes != null ? ` / ~${opts.gapBehind.minutes} min` : ''
      } behind`
    : '';
  const base = `🚌 ${title} — ${pattern.direction}\n\n${bunch.vehicles.length} buses within ${formatDistance(bunch.spanFt)} near ${stop.stopName}${recordLine}${gapLine}${busesLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(bunch, pattern, stop) {
  return `Map of ${routeTitle(bunch.route)} near ${stop.stopName} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses within ${formatDistance(bunch.spanFt)} of each other.`;
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

function buildVideoAltText(bunch, pattern, stop, result) {
  return `Timelapse map of ${routeTitle(bunch.route)} near ${stop.stopName} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses moving over ${formatMinSec(result.elapsedSec)}.`;
}

module.exports = { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText };
