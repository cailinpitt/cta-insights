const { LINE_NAMES, shortStationName } = require('./api');
const { formatCallouts } = require('../shared/history');
const { formatMinutes } = require('../shared/format');

function buildPostText(gap, callouts = []) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name || gap.leading.nextStation);
  const whereClause = where ? ` near ${where}` : '';
  // `leading` is the train already past the gap (last seen);
  // `trailing` is the next one a rider is waiting for.
  const last = gap.leading?.rn ? `#${gap.leading.rn}` : null;
  const next = gap.trailing?.rn ? `#${gap.trailing.rn}` : null;
  const runsLine = (last || next)
    ? `\nRuns: ${[last && `${last} (last)`, next && `${next} (next)`].filter(Boolean).join(', ')}`
    : '';
  const base = `🕳️ ${lineName} Line — to ${dest}\n${formatMinutes(gap.gapMin)} gap${whereClause} — currently scheduled every ${formatMinutes(gap.expectedMin)}${runsLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
}

function buildAltText(gap) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name);
  const whereClause = where ? ` near ${where}` : '';
  return `Map of the ${lineName} Line toward ${dest} showing a ${formatMinutes(gap.gapMin)} gap between trains${whereClause}.`;
}

module.exports = { buildPostText, buildAltText };
