const { names: routeNames } = require('./routes');
const { formatCallouts } = require('../shared/history');
const { formatMinutes } = require('../shared/format');

function routeTitle(route) {
  const name = routeNames[route];
  return name ? `Route ${route} (${name})` : `Route ${route}`;
}

function buildPostText(gap, pattern, stop, callouts = []) {
  // `leading` is the bus already past the gap (last seen);
  // `trailing` is the next one a rider is waiting for.
  const last = gap.leading?.vid ? `#${gap.leading.vid}` : null;
  const next = gap.trailing?.vid ? `#${gap.trailing.vid}` : null;
  const busesLine =
    last || next
      ? `\nBuses: ${[last && `${last} (last)`, next && `${next} (next)`].filter(Boolean).join(', ')}`
      : '';
  const base = `🕳️ ${routeTitle(gap.route)} — ${pattern.direction}\n${formatMinutes(gap.gapMin)} gap near ${stop.stopName} — scheduled around every ${formatMinutes(gap.expectedMin)} this hour${busesLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
}

function buildAltText(gap, pattern, stop) {
  return `Map of ${routeTitle(gap.route)} ${pattern.direction.toLowerCase()} showing a ${formatMinutes(gap.gapMin)} gap between buses near ${stop.stopName}.`;
}

module.exports = { buildPostText, buildAltText };
