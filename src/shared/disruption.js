// Disruption shape:
//   { line, suspendedSegment: {from, to}, alternative: {type, from, to}|null,
//     reason?, source: 'cta-alert'|'observed', detectedAt }
//
// `source` drives footer phrasing: 'cta-alert' quotes CTA, 'observed' makes
// clear the bot is inferring from live positions.

const { LINE_NAMES } = require('../train/api');

function titleFor(d) {
  const lineName = LINE_NAMES[d.line] || d.line;
  return `⚠ ${lineName} Line service suspended`;
}

function buildPostText(d) {
  const { suspendedSegment, alternative, reason, source } = d;
  const lines = [titleFor(d)];
  const reasonPhrase = reason ? ` (${reason})` : '';
  lines.push('', `Between ${suspendedSegment.from} and ${suspendedSegment.to}${reasonPhrase}.`);
  if (alternative?.type === 'shortTurn') {
    lines.push(`Trains currently running: ${alternative.from} ↔ ${alternative.to}.`);
  } else if (alternative?.type === 'shuttle') {
    lines.push(`Shuttle buses running: ${alternative.from} ↔ ${alternative.to}.`);
  }
  lines.push('', footerFor(source));
  return lines.join('\n');
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
  if (source === 'observed') return "Based on what the bot sees; CTA hasn't issued an alert for this yet.";
  return '';
}

module.exports = { buildPostText, buildAltText, titleFor, footerFor };
