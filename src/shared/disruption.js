// Disruption shape:
//   { line, suspendedSegment: {from, to}, alternative: {type, from, to}|null,
//     reason?, source: 'cta-alert'|'observed', detectedAt }
//
// `source` drives footer phrasing: 'cta-alert' quotes CTA, 'observed' makes
// clear the bot is inferring from live positions.

const { LINE_NAMES } = require('../train/api');

// Terminus label per line + direction for round-trip Loop lines. Used in
// post titles so readers know which direction's trains are missing — saying
// "trains toward 54th/Cermak not seen" is far clearer than "outbound" for
// a non-rider audience.
const DIRECTION_TERMINUS = {
  brn: { outbound: 'Kimball', inbound: 'the Loop' },
  org: { outbound: 'Midway', inbound: 'the Loop' },
  pink: { outbound: '54th/Cermak', inbound: 'the Loop' },
  p: { outbound: 'Linden', inbound: 'the Loop' },
};

function terminusFor(d) {
  if (!d.directionHint) return null;
  return DIRECTION_TERMINUS[d.line]?.[d.directionHint] || null;
}

function titleFor(d) {
  const lineName = LINE_NAMES[d.line] || d.line;
  // CTA-confirmed alerts use the strong "suspended" framing because CTA is
  // authoritative. Observed pulses are an inference from sparse position
  // snapshots, so they hedge — "possible service gap" reads as a flag worth
  // checking rather than an official outage declaration.
  if (d.source === 'cta-alert') return `🚇⚠️ ${lineName} Line service suspended`;
  // Round-trip lines (Brown/Orange/Pink/Purple) detect per-direction; without
  // a direction qualifier in the title, "trains not seen" reads as both
  // directions which is misleading when the other direction is running. Use
  // the terminus name rather than "outbound/inbound" so the audience doesn't
  // need to know rail-system jargon to read the post.
  const terminus = terminusFor(d);
  if (terminus) {
    return `🚇⚠️ ${lineName} Line: trains to ${terminus} not seen`;
  }
  return `🚇⚠️ ${lineName} Line: trains not seen`;
}

const POST_GRAPHEME_LIMIT = 300;

function graphemeLen(s) {
  // Bluesky enforces grapheme count, not UTF-16 length. Use Intl.Segmenter
  // when available; fall back to character length (a slight overcount that
  // errs on the side of trimming, which is safer than under-counting).
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    let n = 0;
    for (const _ of seg.segment(s)) n++;
    return n;
  }
  return [...s].length;
}

function buildPostText(d, { ctaAlertOpen = false } = {}) {
  const { suspendedSegment, alternative, reason, source, evidence } = d;
  const reasonPhrase = reason ? ` (${reason})` : '';
  // Build the evidence line in two tiers — full and short — so we can
  // gracefully shed the longest parenthetical (and then the second longest)
  // when station names + terminus name push the post past Bluesky's 300-
  // grapheme cap. The post is the source of truth; an over-length post fails
  // outright on AT-proto, so we have to fit the limit before sending.
  const fullEvidence = source === 'observed' && evidence ? evidenceLine(evidence) : null;
  const shortEvidence =
    source === 'observed' && evidence ? evidenceLine(evidence, { compact: true }) : null;

  const compose = (evidenceText) => {
    const lines = [titleFor(d)];
    lines.push('', `Between ${suspendedSegment.from} and ${suspendedSegment.to}${reasonPhrase}.`);
    if (alternative?.type === 'shortTurn') {
      lines.push(`Trains currently running: ${alternative.from} ↔ ${alternative.to}.`);
    } else if (alternative?.type === 'shuttle') {
      lines.push(`Shuttle buses running: ${alternative.from} ↔ ${alternative.to}.`);
    }
    if (evidenceText) lines.push('', evidenceText);
    lines.push('', footerFor(source, { ctaAlertOpen }));
    return lines.join('\n');
  };

  let text = compose(fullEvidence);
  if (graphemeLen(text) <= POST_GRAPHEME_LIMIT) return text;
  text = compose(shortEvidence);
  if (graphemeLen(text) <= POST_GRAPHEME_LIMIT) return text;
  // Last resort: drop evidence entirely. Title + segment + footer is the
  // bare minimum that still communicates the alert.
  return compose(null);
}

function evidenceLine(e, { compact = false } = {}) {
  if (e.synthetic) {
    const stations = e.coldStations >= 2 ? ` (${e.coldStations} stations affected)` : '';
    return `📡 No trains observed anywhere on the line in the last ${e.lookbackMin || 20} min${stations}.`;
  }
  const stretch = e.runLengthMi != null ? `${e.runLengthMi}-mi stretch` : 'this stretch';
  const stations = e.coldStations >= 2 ? ` (${e.coldStations} stations affected)` : '';
  const since =
    e.minutesSinceLastTrain != null
      ? `the last ${e.minutesSinceLastTrain} min`
      : `the last ${e.lookbackMin || 20} min`;
  // In compact mode drop the two parentheticals — they're additive context,
  // not load-bearing for the alert. Saves ~50–60 chars to keep the post
  // under Bluesky's 300-grapheme cap when station + terminus names are long.
  if (compact) {
    return `📡 No trains seen on this ${stretch}${stations} in ${since}.`;
  }
  const missing =
    e.expectedTrains != null && e.expectedTrains >= 1
      ? ` — ~${e.expectedTrains} train${e.expectedTrains === 1 ? '' : 's'} missed`
      : '';
  const elsewhere =
    e.trainsOutsideRun != null
      ? ` (${e.trainsOutsideRun} train${e.trainsOutsideRun === 1 ? '' : 's'} active elsewhere on the line)`
      : '';
  return `📡 No trains seen on this ${stretch}${stations} in ${since}${missing}${elsewhere}.`;
}

function buildAltText(d) {
  const lineName = LINE_NAMES[d.line] || d.line;
  const terminus = terminusFor(d);
  const directionPhrase = terminus ? ` heading to ${terminus}` : '';
  const dimDescription =
    d.source === 'cta-alert'
      ? 'dimmed to indicate service is suspended'
      : `dimmed to indicate no trains${directionPhrase} were seen on this segment`;
  const base = `Map of the ${lineName} Line with the segment between ${d.suspendedSegment.from} and ${d.suspendedSegment.to} ${dimDescription}.`;
  if (d.alternative?.type === 'shortTurn') {
    return `${base} Trains are running short-turned between ${d.alternative.from} and ${d.alternative.to}.`;
  }
  if (d.alternative?.type === 'shuttle') {
    return `${base} Shuttle buses are running between ${d.alternative.from} and ${d.alternative.to}.`;
  }
  return base;
}

function footerFor(source, { ctaAlertOpen = false } = {}) {
  if (source === 'cta-alert') return 'Per CTA. Check transitchicago.com for updates.';
  if (source === 'observed') {
    return ctaAlertOpen
      ? 'Inferred from live train positions. (See CTA alert in this thread.)'
      : "Inferred from live train positions; CTA hasn't issued an alert for this yet.";
  }
  return '';
}

function buildClearPostText(d, { ctaAlertOpen = false } = {}) {
  const lineName = LINE_NAMES[d.line] || d.line;
  const tail = ctaAlertOpen
    ? "(CTA hasn't cleared their alert yet.)"
    : "(CTA hasn't issued an alert for this.)";
  return `🚇✅ ${lineName} Line trains running through ${d.suspendedSegment.from} ↔ ${d.suspendedSegment.to} again. ${tail}`;
}

function buildBusPostText(
  { route, name, lookbackMin, minHeadwayMin },
  { ctaAlertOpen = false } = {},
) {
  const header = `🚌⚠️ #${route} ${name} service appears suspended`;
  const headwayClause =
    minHeadwayMin != null ? ` — currently scheduled every ${Math.round(minHeadwayMin)} min` : '';
  const evidence = `📡 No buses observed on the route in the last ${lookbackMin} min${headwayClause}.`;
  const footer = ctaAlertOpen
    ? 'Inferred from live bus positions. (See CTA alert in this thread.)'
    : "Inferred from live bus positions; CTA hasn't issued an alert for this yet.";
  return `${header}\n\n${evidence}\n\n${footer}`;
}

function buildBusClearPostText({ route, name }, { ctaAlertOpen = false } = {}) {
  const tail = ctaAlertOpen
    ? "(CTA hasn't cleared their alert yet.)"
    : "(CTA hasn't issued an alert for this.)";
  return `🚌✅ #${route} ${name} buses observed again. ${tail}`;
}

module.exports = {
  buildPostText,
  buildAltText,
  buildClearPostText,
  buildBusPostText,
  buildBusClearPostText,
  titleFor,
  footerFor,
  evidenceLine,
};
