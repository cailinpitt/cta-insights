const { LINE_NAMES, shortStationName } = require('./api');
const { formatCallouts } = require('../shared/history');
const { formatMinutes, formatDistance, elapsedMinutesLabel } = require('../shared/format');

function buildPostText(gap, callouts = []) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name || gap.leading.nextStation);
  const whereClause = where ? ` near ${where}` : '';
  // `leading` is the train already past the gap (last seen); `trailing` is the
  // next one a rider is waiting for. "(last)/(next)" read as ambiguous ("last
  // train" = final train of the night), so spell the rider roles out — the map
  // tags the two discs L/N to match.
  const lastSeen = gap.leading?.rn ? `#${gap.leading.rn}` : null;
  const nextUp = gap.trailing?.rn ? `#${gap.trailing.rn}` : null;
  const runsLine =
    lastSeen || nextUp
      ? `\n\n${[lastSeen && `Last seen: ${lastSeen}`, nextUp && `Next up: ${nextUp}`].filter(Boolean).join(' · ')}`
      : '';
  // Lead with the lived effect — "No train for ~24 min" reads as the service
  // hole a rider is sitting in, not an abstract "gap." Tilde on the modeled
  // span: it's a distance/speed estimate, not a measured ETA (see docs/GAPS.md).
  // The schedule headway stays bare — it's a lookup.
  const base = `🕳️ ${lineName} Line — to ${dest}\n\nNo train${whereClause} for ~${formatMinutes(gap.gapMin)} — currently scheduled every ${formatMinutes(gap.expectedMin)}${runsLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(gap) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const where = shortStationName(gap.nearStation?.name);
  const whereClause = where ? ` near ${where}` : '';
  return `Map of the ${lineName} Line toward ${dest} showing a ${formatMinutes(gap.gapMin)} gap between trains${whereClause}.`;
}

// Timelapse reply text. Leads with the full effect — how long the line has gone
// without a train — then the next train's progress toward the platform, so the
// "next train ~N min" half doesn't undersell a gap whose first half already
// elapsed.
function buildGapVideoPostText(gap, result) {
  const stop = shortStationName(result.stopName) || 'the stop';
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  const lead = `The ${LINE_NAMES[gap.line]} Line hasn't had a train in ~${result.gapMin} min.`;
  if (result.reached) {
    return `${lead} ${elapsed} later, the next one reached ${stop}.`;
  }
  return `${lead} ${elapsed} later, the next one had closed to ${formatDistance(result.endDistFt)} from ${stop}.`;
}

function buildGapVideoAltText(gap, result) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const stop = shortStationName(result.stopName) || 'the stop';
  return `Timelapse map of the ${lineName} Line toward ${dest} showing the next train approaching ${stop} over ${formatMinutes(result.elapsedSec / 60)}.`;
}

module.exports = { buildPostText, buildAltText, buildGapVideoPostText, buildGapVideoAltText };
