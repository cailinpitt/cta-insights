// Disruption shape:
//   { line, suspendedSegment: {from, to}, alternative: {type, from, to}|null,
//     reason?, source: 'cta-alert'|'observed', detectedAt }
//
// `source` drives footer phrasing: 'cta-alert' quotes CTA, 'observed' makes
// clear the bot is inferring from live positions.

const { LINE_NAMES } = require('../train/api');

// Static terminus fallback per line + direction for round-trip Loop lines.
// Used only when the detector didn't supply an empirical destination — see
// directionDestinationName, which is derived from where the trDr-matched
// trains actually end up in the active service corridor. The static map is
// only correct on weekday peaks (e.g. Purple Express runs through to the
// Loop); on Sundays the Purple shuttle terminates at Howard, and the
// detector-supplied value picks that up.
const DIRECTION_TERMINUS = {
  brn: { outbound: 'Kimball', inbound: 'the Loop' },
  org: { outbound: 'Midway', inbound: 'the Loop' },
  pink: { outbound: '54th/Cermak', inbound: 'the Loop' },
  p: { outbound: 'Linden', inbound: 'the Loop' },
};

function terminusFor(d) {
  if (d.directionDestinationName) return d.directionDestinationName;
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
  if (d.kind === 'held' || d.source === 'observed-held') {
    const anchor = d.suspendedSegment?.from || 'this stretch';
    return `🚇🚨 ${lineName} Line: service halted around ${anchor}`;
  }
  // Cold-segment detection measures whether trains have *advanced through* a
  // stretch — bins warm only when a new train enters them. A train held in a
  // station keeps pinging the same bin and reads "cold" once the threshold
  // passes, even though the train is still visible on the map. The title and
  // evidence wording reflect this: "stalled" is accurate whether trains are
  // missing or just stopped, and doesn't contradict riders who can see trains
  // sitting in stations on CTA's own train tracker. Round-trip lines
  // (Brown/Orange/Pink/Purple) detect per-direction; without the terminus
  // qualifier the title reads as both directions even when the other is fine.
  const terminus = terminusFor(d);
  if (terminus) {
    return `🚇⚠️ ${lineName} Line: trains toward ${terminus} stalled`;
  }
  return `🚇⚠️ ${lineName} Line: trains stalled`;
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
  const isObserved = source === 'observed' || source === 'observed-held';
  const fullEvidence = isObserved && evidence ? evidenceLine(evidence, { kind: d.kind }) : null;
  const shortEvidence =
    isObserved && evidence ? evidenceLine(evidence, { compact: true, kind: d.kind }) : null;

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

function evidenceLine(e, { compact = false, kind = 'cold' } = {}) {
  if (kind === 'held' && e.held) {
    const minutes = Math.round((e.held.stationaryMs || 0) / 60000);
    const stationsList =
      e.coldStationNames && e.coldStationNames.length > 0
        ? ` near ${e.coldStationNames.slice(0, 3).join(', ')}`
        : '';
    return `🛑 ${e.held.trainCount} train${e.held.trainCount === 1 ? '' : 's'} stationary ${minutes}+ min${stationsList}. No moving trains nearby.`;
  }
  // Scheduled-headway clause is what tells readers "18 min cold is unusual" —
  // include in both full and compact tiers so the schedule context survives
  // the post-length shedder. Dropped only as part of the third (no-evidence)
  // fallback in buildPostText.
  const headwayClause =
    e.headwayMin != null ? ` — scheduled every ${Math.round(e.headwayMin)} min` : '';
  if (e.synthetic) {
    const stations = e.coldStations >= 2 ? ` (${e.coldStations} stations affected)` : '';
    return `📡 No trains observed anywhere on the line in the last ${e.lookbackMin || 20} min${stations}${headwayClause}.`;
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
  // The "Trains may be holding" hint stays in both tiers — it's what makes
  // the post accurate when trains are visible on the map but not advancing.
  // Compact mode sheds the missing/elsewhere parentheticals only.
  if (compact) {
    return `📡 No trains have moved through this ${stretch}${stations} in ${since}${headwayClause}. Trains may be holding in stations.`;
  }
  const missing =
    e.expectedTrains != null && e.expectedTrains >= 1
      ? `, ~${e.expectedTrains} train${e.expectedTrains === 1 ? '' : 's'} missed`
      : '';
  const elsewhere =
    e.trainsOutsideRun != null
      ? ` (${e.trainsOutsideRun} train${e.trainsOutsideRun === 1 ? '' : 's'} still moving elsewhere on the line)`
      : '';
  return `📡 No trains have moved through this ${stretch}${stations} in ${since}${headwayClause}${missing}${elsewhere}. Trains may be holding in stations.`;
}

function buildAltText(d) {
  const lineName = LINE_NAMES[d.line] || d.line;
  const terminus = terminusFor(d);
  const directionPhrase = terminus ? ` toward ${terminus}` : '';
  let dimDescription;
  if (d.source === 'cta-alert') {
    dimDescription = 'dimmed to indicate service is suspended';
  } else if (d.kind === 'held' || d.source === 'observed-held') {
    dimDescription = `dimmed to indicate trains${directionPhrase} are held in stations there`;
  } else {
    dimDescription = `dimmed to indicate trains${directionPhrase} have not advanced through that stretch`;
  }
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
  if (source === 'observed' || source === 'observed-held') {
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
