const { LINE_NAMES, ALL_LINES } = require('./api');
const { formatTimeCT } = require('../shared/format');

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

function buildVideoPostText(trains, startTs, endTs, windowMin, startTrains) {
  const byLine = countByLine(trains);
  const parts = ALL_LINES.map((l) => `${LINE_NAMES[l]} ${byLine.get(l) || 0}`);
  const countLine =
    startTrains && startTrains.length !== trains.length
      ? `${startTrains.length} → ${trains.length} trains (start → end of window)`
      : `${trains.length} trains`;
  return `🚆 CTA L · ${windowMin}-min timelapse\n${formatTimeCT(startTs)}–${formatTimeCT(endTs)} CT · ${countLine}\n\n${parts.join(' · ')}`;
}

function buildVideoAltText(trains, windowMin) {
  const byLine = countByLine(trains);
  const summary = ALL_LINES.map((l) => `${byLine.get(l) || 0} ${LINE_NAMES[l]}`).join(', ');
  return `${windowMin}-minute timelapse of CTA L train movement across Chicago, colored by line. Final frame shows ${trains.length} trains in service: ${summary}.`;
}

module.exports = {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
  countByLine,
};
