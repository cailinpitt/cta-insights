const { LINE_NAMES, shortStationName } = require('./api');
const { formatCallouts } = require('../shared/history');
const { formatMinutes, elapsedMinutesLabel, formatDistance } = require('../shared/format');

function buildPostText(gap, callouts = []) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  // Name the empty stretch as a range between the stations flanking it. A long
  // gap can span several stops, so "near <midpoint>" both under-states the hole
  // and disagrees with the map (which labels the flanks). Fall back to the
  // midpoint station when a flank is missing (e.g. gap reaching toward a
  // terminal), and to nothing when we have neither.
  const before = shortStationName(gap.flankBefore?.name);
  const after = shortStationName(gap.flankAfter?.name);
  const mid = shortStationName(gap.nearStation?.name || gap.leading.nextStation);
  let whereClause = '';
  if (before && after) whereClause = ` between ${before} and ${after}`;
  else if (before || after) whereClause = ` past ${before || after}`;
  else if (mid) whereClause = ` near ${mid}`;
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
  // Frame the number as a gap *between trains*, not "no train for ~N min" —
  // that older phrasing read as "N minutes since a train was here," but the
  // span actually measures the distance between the two trains bracketing the
  // stretch. Tilde on the modeled span: it's a distance/speed estimate, not a
  // measured ETA (see docs/GAPS.md). The schedule headway stays bare — a lookup.
  const base = `🕳️ ${lineName} Line — to ${dest}\n\nNo trains${whereClause} — a ~${formatMinutes(gap.gapMin)} gap, scheduled every ${formatMinutes(gap.expectedMin)}${runsLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(gap) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const before = shortStationName(gap.flankBefore?.name);
  const after = shortStationName(gap.flankAfter?.name);
  const mid = shortStationName(gap.nearStation?.name);
  let whereClause = ' between trains';
  if (before && after) whereClause = ` with no trains between ${before} and ${after}`;
  else if (mid) whereClause = ` between trains near ${mid}`;
  return `Map of the ${lineName} Line toward ${dest} showing a ${formatMinutes(gap.gapMin)} gap${whereClause}.`;
}

// Timelapse reply text. The clip is framed at the gap *midpoint*, and the
// trailing ("Next up") train is filmed closing on it — so the reply names that
// midpoint stop and flags it as "the middle of the gap" to explain why the
// train still has distance to cover (it's only crossing the back half). Tying
// the run number to the still post's "Next up: #N" line keeps the thread
// coherent. Progress is the concrete remaining distance, not a vague bucket.
function buildGapVideoPostText(gap, result) {
  const lineName = LINE_NAMES[gap.line];
  const station = shortStationName(gap.nearStation?.name || gap.leading.nextStation);
  const run = gap.trailing?.rn ? ` (#${gap.trailing.rn})` : '';
  const elapsed = elapsedMinutesLabel(result.elapsedSec);
  const lead = `~${result.gapMin} min ${lineName} Line gap.`;
  if (result.reached) {
    const where = station ? `${station} — the middle of the gap —` : 'the middle of the gap';
    return `${lead} The next train${run} reached ${where} ${elapsed} later.`;
  }
  const remaining = formatDistance(Math.max(0, result.endDistFt || 0));
  const where = station ? `${station} — the middle of the gap` : 'the middle of the gap';
  return `${lead} ${elapsed} later, the next train${run} had closed to within ~${remaining} of ${where}.`;
}

function buildGapVideoAltText(gap, result) {
  const lineName = LINE_NAMES[gap.line];
  const dest = gap.leading.destination;
  const stop = shortStationName(result.stopName) || shortStationName(gap.nearStation?.name);
  const where = stop ? `${stop}, the middle of the gap,` : 'the middle of the gap';
  return `Timelapse map of the ${lineName} Line toward ${dest}: the next train closing on ${where} over ${formatMinutes(result.elapsedSec / 60)}.`;
}

module.exports = { buildPostText, buildAltText, buildGapVideoPostText, buildGapVideoAltText };
