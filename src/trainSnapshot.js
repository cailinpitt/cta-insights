const { LINE_NAMES, ALL_LINES } = require('./trainApi');

function formatTimeCT(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago',
  });
}

function countByLine(trains) {
  const byLine = new Map();
  for (const t of trains) byLine.set(t.line, (byLine.get(t.line) || 0) + 1);
  return byLine;
}

function buildPostText(trains, now) {
  const byLine = countByLine(trains);
  const parts = ALL_LINES.map((l) => `${LINE_NAMES[l]} ${byLine.get(l) || 0}`);
  return `🚆 CTA L right now\n${formatTimeCT(now)} CT · ${trains.length} trains system-wide\n\n${parts.join(' · ')}`;
}

function buildAltText(trains) {
  const byLine = countByLine(trains);
  const summary = ALL_LINES.map((l) => `${byLine.get(l) || 0} ${LINE_NAMES[l]}`).join(', ');
  return `Map of Chicago showing live positions of ${trains.length} CTA L trains currently in service, colored by line: ${summary}.`;
}

module.exports = { buildPostText, buildAltText, countByLine };
