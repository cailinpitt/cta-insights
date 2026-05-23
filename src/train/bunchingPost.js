const { LINE_NAMES, shortStationName } = require('./api');
const { assignTrainNumbers } = require('./bunching');
const { formatCallouts } = require('../shared/history');
const { formatDistance, formatMinSec, elapsedMinutesLabel } = require('../shared/format');

function buildPostText(bunch, callouts = [], opts = {}) {
  const lineName = LINE_NAMES[bunch.line];
  const dest = bunch.trains[0].destination;
  const station = shortStationName(bunch.trains[0].nextStation);
  const count = bunch.trains.length;
  // Tag each run with the identity number it carries on the map/video so a
  // reader can tie a numbered disc back to its train. Listed in number order
  // (matches track order) so the parenthetical reads 1, 2, 3… down the line.
  const labels = assignTrainNumbers(bunch.trains);
  const runs = bunch.trains
    .filter((t) => t.rn != null)
    .map((t) => ({ label: `#${t.rn}`, n: labels.get(t.rn) }))
    .sort((a, b) => a.n - b.n)
    .map((x) => `${x.label} (${x.n})`)
    .join(', ');
  const runsLine = runs ? `\n\nRuns: ${runs}` : '';
  // The gap the bunch leaves behind it is the rider-facing cost — the wait the
  // next person on the platform faces. Distance always; minutes when a
  // scheduled pace is known.
  const gapLine = opts.gapBehind
    ? `\n\nNext train ${formatDistance(opts.gapBehind.distFt)}${
        opts.gapBehind.minutes != null ? ` / ~${opts.gapBehind.minutes} min` : ''
      } behind`
    : '';
  const base = `🚆 ${lineName} Line — to ${dest}\n\n${count} trains within ${formatDistance(bunch.spanFt)} near ${station}${gapLine}${runsLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
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
  if (delta > 50)
    headline = `${elapsed} later, the trains were ${formatDistance(delta)} farther apart.`;
  else if (delta < -50)
    headline = `${elapsed} later, the gap had closed by ${formatDistance(-delta)}.`;
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
