const { LINE_NAMES, shortStationName } = require('./api');
const { formatCallouts } = require('../shared/history');
const { formatDistance, formatMinSec, elapsedMinutesLabel } = require('../shared/format');

function buildPostText(bunch, callouts = []) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = shortStationName(bunch.trains[0].nextStation);
  const count = bunch.trains.length;
  const runs = bunch.trains.map((t) => `#${t.rn}`).filter((s) => s !== '#undefined').join(', ');
  const runsLine = runs ? `\nRuns: ${runs}` : '';
  const base = `🚆 ${lineName} Line — to ${dest}\n${count} trains within ${formatDistance(bunch.spanFt)} near ${station}${runsLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
}

function buildAltText(bunch) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = shortStationName(bunch.trains[0].nextStation);
  const count = bunch.trains.length;
  return `Map of the ${lineName} Line near ${station} showing ${count} trains to ${dest} within ${formatDistance(bunch.spanFt)} of each other.`;
}

function buildVideoPostText(result) {
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  if (result.finalDistFt == null) return `Timelapse of the above — ${elapsed} of real time.`;
  const delta = result.finalDistFt - result.initialDistFt;
  let headline;
  if (delta > 50) headline = `${elapsed} later, the trains were ${formatDistance(delta)} farther apart.`;
  else if (delta < -50) headline = `${elapsed} later, the gap had closed by ${formatDistance(-delta)}.`;
  else headline = `Still bunched ${elapsed} later.`;
  return `${headline}\n🎬 ${formatDistance(result.initialDistFt)} → ${formatDistance(result.finalDistFt)}`;
}

function buildVideoAltText(bunch, result) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = shortStationName(bunch.trains[0].nextStation);
  const count = bunch.trains.length;
  return `Timelapse map of the ${lineName} Line near ${station} showing ${count} trains to ${dest} moving over ${formatMinSec(result.elapsedSec)}.`;
}

module.exports = { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText };
