const { LINE_NAMES, shortStationName } = require('./api');
const { formatCallouts } = require('../shared/history');
const { formatMinutes } = require('../shared/format');

function buildPostText(gap, callouts = []) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name || gap.leading.nextStation);
  const whereClause = where ? ` near ${where}` : '';
  const base = `🕳️ ${lineName} Line — to ${dest}\n${formatMinutes(gap.gapMin)} gap${whereClause} — currently scheduled every ${formatMinutes(gap.expectedMin)}`;
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
