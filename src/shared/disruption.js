// Disruption shape:
//   { line, suspendedSegment: {from, to}, alternative: {type, from, to}|null,
//     reason?, source: 'cta-alert'|'observed', detectedAt }
//
// `source` drives footer phrasing: 'cta-alert' quotes CTA, 'observed' makes
// clear the bot is inferring from live positions.

const { LINE_NAMES } = require('../train/api');

function titleFor(d) {
  const lineName = LINE_NAMES[d.line] || d.line;
  return `⚠️ ${lineName} Line service suspended`;
}

function buildPostText(d) {
  const { suspendedSegment, alternative, reason, source, evidence } = d;
  const lines = [titleFor(d)];
  const reasonPhrase = reason ? ` (${reason})` : '';
  lines.push('', `Between ${suspendedSegment.from} and ${suspendedSegment.to}${reasonPhrase}.`);
  if (alternative?.type === 'shortTurn') {
    lines.push(`Trains currently running: ${alternative.from} ↔ ${alternative.to}.`);
  } else if (alternative?.type === 'shuttle') {
    lines.push(`Shuttle buses running: ${alternative.from} ↔ ${alternative.to}.`);
  }
  if (source === 'observed' && evidence) {
    lines.push('', evidenceLine(evidence));
  }
  lines.push('', footerFor(source));
  return lines.join('\n');
}

function evidenceLine(e) {
  if (e.synthetic) {
    const stations = e.coldStations >= 2 ? ` (${e.coldStations} stations affected)` : '';
    return `📡 No trains observed on this line in the last ${e.lookbackMin || 20} min${stations} — service appears suspended line-wide.`;
  }
  const stretch = e.runLengthMi != null ? `${e.runLengthMi}-mi stretch` : 'this stretch';
  const stations = e.coldStations >= 2 ? ` (${e.coldStations} stations affected)` : '';
  const since =
    e.minutesSinceLastTrain != null
      ? `the last ${e.minutesSinceLastTrain} min`
      : `the last ${e.lookbackMin || 20} min`;
  const missing =
    e.expectedTrains != null && e.expectedTrains >= 1
      ? ` — ~${e.expectedTrains} trains missed`
      : '';
  const elsewhere =
    e.trainsOutsideRun != null
      ? ` (${e.trainsOutsideRun} train${e.trainsOutsideRun === 1 ? '' : 's'} active elsewhere on the line)`
      : '';
  return `📡 No trains seen on this ${stretch}${stations} in ${since}${missing}${elsewhere}.`;
}

function buildAltText(d) {
  const lineName = LINE_NAMES[d.line] || d.line;
  const base = `Map of the ${lineName} Line with the segment between ${d.suspendedSegment.from} and ${d.suspendedSegment.to} dimmed to indicate service is suspended.`;
  if (d.alternative?.type === 'shortTurn') {
    return `${base} Trains are running short-turned between ${d.alternative.from} and ${d.alternative.to}.`;
  }
  if (d.alternative?.type === 'shuttle') {
    return `${base} Shuttle buses are running between ${d.alternative.from} and ${d.alternative.to}.`;
  }
  return base;
}

function footerFor(source) {
  if (source === 'cta-alert') return 'Per CTA. Check transitchicago.com for updates.';
  if (source === 'observed')
    return "Inferred from live train positions; CTA hasn't issued an alert for this yet.";
  return '';
}

function buildClearPostText(d, { ctaAlertOpen = false } = {}) {
  const lineName = LINE_NAMES[d.line] || d.line;
  const tail = ctaAlertOpen
    ? "(CTA hasn't cleared their alert yet.)"
    : "(CTA hasn't issued an alert for this.)";
  return `✅ ${lineName} Line trains running through ${d.suspendedSegment.from} ↔ ${d.suspendedSegment.to} again. ${tail}`;
}

module.exports = {
  buildPostText,
  buildAltText,
  buildClearPostText,
  titleFor,
  footerFor,
  evidenceLine,
};
