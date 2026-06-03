// Plain-English descriptions for bot-observation events, generated server-side
// at export time so the web app stays a dumb renderer. The detection sentence
// ("Route 124 service appears degraded — …") and the matching resolution
// sentence ("Buses observed on Route 124 again, …") both live here so any
// future signal additions only need one source-of-truth update.
//
// Each describe* function returns a sentence or null; null tells the renderer
// to omit the block rather than fall back to chip rendering. Callers should
// pass a row shaped like a disruption/roundup observation (kind, line,
// detection_source, signals).

const TRAIN_LINES = {
  red: 'Red',
  blue: 'Blue',
  brown: 'Brown',
  green: 'Green',
  orange: 'Orange',
  pink: 'Pink',
  purple: 'Purple',
  yellow: 'Yellow',
};

// CTA short-code → full-name aliases. Mirrors cta-alert-history's ctaLines.js
// so a row with `line: 'brn'` describes as "Brown Line" without the renderer
// having to normalize first.
const LINE_ALIAS = {
  brn: 'brown',
  g: 'green',
  org: 'orange',
  p: 'purple',
  y: 'yellow',
};

function normalizeTrainLine(key) {
  if (key == null) return key;
  return LINE_ALIAS[key] ?? key;
}

function observationSignals(obs) {
  if (!obs) return [];
  if (obs.detection_source === 'roundup') {
    if (Array.isArray(obs.signals)) return obs.signals;
    if (typeof obs.signals === 'string') return obs.signals.split(',').filter(Boolean);
    return [];
  }
  return obs.detection_source ? [obs.detection_source] : [];
}

function signalPhrase(signal, kind) {
  switch (signal) {
    case 'gap':
      return kind === 'bus'
        ? 'longer-than-scheduled gaps between buses'
        : 'longer-than-scheduled headways between trains';
    case 'bunching':
      return kind === 'bus' ? 'buses running bunched together' : 'trains running bunched together';
    case 'ghost':
      return kind === 'bus' ? 'fewer buses than scheduled' : 'fewer trains than scheduled';
    case 'pulse-cold':
      return 'a stretch of the line without trains';
    case 'pulse-held':
      return 'trains held in place';
    case 'thin-gap':
      return 'no buses observed within a full scheduled headway';
    default:
      return null;
  }
}

function botObservationSubject(incident) {
  if (incident.kind === 'bus') {
    const route = incident.line;
    if (!route) return null;
    return `Route ${route} service`;
  }
  const lineKey = normalizeTrainLine(incident.line);
  const label = TRAIN_LINES[lineKey];
  if (!label) return null;
  return `${label} Line service`;
}

function joinPhrases(phrases) {
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`;
}

function isMergedOrAlert(incident) {
  return !!(incident && (incident._type === 'merged' || incident.alert_id));
}

function describeBotObservation(incident) {
  if (!incident) return null;
  if (isMergedOrAlert(incident)) return null;

  const signals = observationSignals(incident);
  const kind = incident.kind === 'bus' ? 'bus' : 'train';
  const phrases = signals.map((s) => signalPhrase(s, kind)).filter((p) => p != null);
  if (phrases.length === 0) return null;

  const subject = botObservationSubject(incident);
  if (!subject) return null;

  return `${subject} appears degraded — ${joinPhrases(phrases)}.`;
}

// Resolution sentence companion to describeBotObservation. Tailors the lead
// clause to the signal *category* so the sentence doesn't overclaim:
//
//   - absence (thin-gap, pulse-cold): vehicles weren't visible → "observed
//     again"
//   - paralysis (pulse-held): vehicles were visible but stuck → "moving
//     again"
//   - degradation (gap, bunching, ghost — including any roundup that bundles
//     them): vehicles were visible AND moving, service was just uneven →
//     drop the lead clause entirely. Saying "observed again" here would be
//     wrong because the trains were always observed.
function describeBotResolution(incident) {
  if (!incident) return null;
  if (isMergedOrAlert(incident)) return null;

  const signals = observationSignals(incident);
  if (signals.length === 0) return null;
  const known = signals.filter((s) => signalPhrase(s, 'bus') != null);
  if (known.length === 0) return null;

  const subject = botObservationSubject(incident);
  if (!subject) return null;

  const ABSENCE = new Set(['thin-gap', 'pulse-cold']);
  const PARALYSIS = new Set(['pulse-held']);
  const allAbsence = known.every((s) => ABSENCE.has(s));
  const allParalysis = known.every((s) => PARALYSIS.has(s));

  // Degradation (or any mixed bag) gets the minimal sentence — no leading
  // clause about vehicles being visible or moving, since neither was the
  // problem.
  if (!allAbsence && !allParalysis) {
    return `${subject} appears to be back to normal.`;
  }

  // Subject is "Route 124 service" / "Brown Line service" — strip the
  // trailing " service" so the sentence reads "on Route 124" / "on the Brown
  // Line" rather than "on Route 124 service".
  const place = subject.replace(/ service$/, '');
  const article = incident.kind === 'bus' ? '' : 'the ';
  const noun = incident.kind === 'bus' ? 'Buses' : 'Trains';
  const verb = allParalysis ? 'moving again' : 'observed again';

  return `${noun} ${verb} on ${article}${place}, service appears to be back to normal.`;
}

// Onset ("when the gap began") sentence for the start-of-issue timeline entry.
// Absence-style observations (pulse-cold / thin-gap) are posted only after the
// stretch has already been cold a while, so the export back-dates onset_ts to
// the last observed vehicle (or, when that predates our position history, the
// cold-threshold floor). This sentence labels that back-dated marker so the
// event timeline has an entry at the real start, not just at detection time.
//
// Two registers, keyed off whether the last vehicle was actually measured:
//   - concrete (minutesSinceLastTrain present): we watched the last vehicle go
//     through, then silence — state it plainly.
//   - floored (minutesSinceLastTrain null): the gap predated our window, so
//     onset is a lower bound — hedge with "at least N min" / "or earlier".
// Returns null for non-absence sources (the renderer omits the entry).
function describeBotOnset(incident) {
  if (!incident) return null;
  if (isMergedOrAlert(incident)) return null;
  const source = incident.detection_source;
  if (source !== 'pulse-cold' && source !== 'thin-gap') return null;
  const evidence = incident.evidence;
  if (!evidence) return null;

  const kind = incident.kind === 'bus' ? 'bus' : 'train';
  const vehicle = kind === 'bus' ? 'bus' : 'train';
  const plural = kind === 'bus' ? 'buses' : 'trains';
  const where = evidence.synthetic ? 'on the line' : 'through this stretch';

  if (evidence.minutesSinceLastTrain != null) {
    return `Last ${vehicle} observed ${where} around here — the service gap began about now.`;
  }
  const floorMin = evidence.coldThresholdMin != null ? Math.round(evidence.coldThresholdMin) : null;
  const dur = floorMin != null ? `at least ${floorMin} min` : 'a while';
  return `No ${plural} ${where} for ${dur} when this was flagged — the gap likely began here or earlier.`;
}

// Per-signal bullet text for the roundup post body. Moved here from
// bin/incident-roundup.js so the post composer and the web export share one
// renderer — the roundup_anchors.bullets column stores raw {source, detail}
// picks, and the event page re-runs this to render them as a <ul>. Keep the
// leading "· " prefix: the bluesky post still depends on it (and existing
// tests assert it), and the web renderer strips it before rendering as a list.
function describeSignal(s, kind) {
  let detail = {};
  try {
    detail = s.detail ? (typeof s.detail === 'string' ? JSON.parse(s.detail) : s.detail) : {};
  } catch (_e) {
    detail = {};
  }
  if (s.source === 'gap') {
    const ratio = Number.isFinite(detail.ratio) ? `${detail.ratio.toFixed(1)}` : '?';
    const noun = kind === 'bus' ? 'buses' : 'trains';
    // Name the empty stretch as a range when the detail carries the flanking
    // stops (forward-only — older anchors stored ratio alone). Mirrors the
    // standalone gap post's "between A and B" phrasing.
    const seg =
      detail.fromStation && detail.toStation
        ? `, between ${detail.fromStation} and ${detail.toStation}`
        : '';
    return `· one gap between ${noun} is ${ratio}x the scheduled wait${seg}`;
  }
  if (s.source === 'ghost') {
    const noun = kind === 'bus' ? 'buses' : 'trains';
    const missing = Math.max(0, Math.round(detail.missing || 0));
    const expected = Math.max(0, Math.round(detail.expected || 0));
    return `· ${missing} of ${expected} ${noun} missing this past hour`;
  }
  if (s.source === 'bunching') {
    const n = detail.vehicles || '?';
    const noun = kind === 'bus' ? 'buses' : 'trains';
    return `· ${n} ${noun} recently bunched together`;
  }
  if (s.source === 'pulse-cold' || s.source === 'pulse-held') {
    const seg =
      detail.fromStation && detail.toStation ? ` ${detail.fromStation} → ${detail.toStation}` : '';
    const noun = kind === 'bus' ? 'buses' : 'trains';
    if (s.source === 'pulse-held') return `· ${noun} appear stuck in place${seg}`;
    return `· possible service gap forming${seg}`;
  }
  return `· ${s.source}`;
}

// Web-side bullet renderer. For roundup observations, the persisted
// `bullets` column carries [{source, detail}] picks straight from the post
// composer; for pulse-* / thin-gap observations we synthesize a single
// bullet from the existing `evidence` JSON so event pages get the same
// concrete numbers the bluesky post showed. Returns an array of strings
// without the bluesky "· " prefix — the page renders them as <ul>.
function describeBotEvidenceBullets(incident) {
  if (!incident) return null;
  if (isMergedOrAlert(incident)) return null;
  // Strip the bluesky "· " bullet glyph, then sentence-case the leading letter.
  // The post intentionally reads lowercase after "· " (it's a bullet item, not a
  // sentence); on the web page each bullet stands alone, so capital reads right.
  const cleanBullet = (s) => {
    if (typeof s !== 'string') return s;
    const stripped = s.replace(/^·\s*/, '');
    return stripped.length > 0 ? stripped[0].toUpperCase() + stripped.slice(1) : stripped;
  };
  const kind = incident.kind === 'bus' ? 'bus' : 'train';

  if (incident.detection_source === 'roundup') {
    const bullets = incident.bullets;
    if (!Array.isArray(bullets) || bullets.length === 0) return null;
    const out = bullets.map((b) => cleanBullet(describeSignal(b, kind))).filter(Boolean);
    return out.length > 0 ? out : null;
  }

  const evidence = incident.evidence;
  if (!evidence) return null;

  if (incident.detection_source === 'pulse-cold' || incident.detection_source === 'thin-gap') {
    const headwayClause =
      evidence.headwayMin != null
        ? ` — scheduled every ${Math.round(evidence.headwayMin)} min`
        : '';
    if (evidence.synthetic) {
      const stations =
        evidence.coldStations >= 2 ? ` (${evidence.coldStations} stations affected)` : '';
      return [
        `No trains observed anywhere on the line in the last ${evidence.lookbackMin || 20} min${stations}${headwayClause}.`,
      ];
    }
    const stretch = evidence.runLengthMi != null ? `${evidence.runLengthMi}-mi stretch` : 'stretch';
    const stations =
      evidence.coldStations >= 2
        ? ` (${evidence.coldStations} station${evidence.coldStations === 1 ? '' : 's'} affected)`
        : '';
    const since =
      evidence.minutesSinceLastTrain != null
        ? `the last ${evidence.minutesSinceLastTrain} min`
        : `the last ${evidence.lookbackMin || 20} min`;
    const missing =
      evidence.expectedTrains != null && evidence.expectedTrains >= 1
        ? `, ~${evidence.expectedTrains} ${kind === 'bus' ? 'bus' : 'train'}${evidence.expectedTrains === 1 ? '' : 's'} missed`
        : '';
    const elsewhere =
      evidence.trainsOutsideRun != null
        ? ` (${evidence.trainsOutsideRun} ${kind === 'bus' ? 'bus' : 'train'}${evidence.trainsOutsideRun === 1 ? '' : 's'} still moving elsewhere on the line)`
        : '';
    return [
      `No ${kind === 'bus' ? 'buses' : 'trains'} moved through this ${stretch}${stations} in ${since}${headwayClause}${missing}${elsewhere}.`,
    ];
  }

  if (incident.detection_source === 'pulse-held' && evidence.held) {
    const minutes = Math.round((evidence.held.stationaryMs || 0) / 60000);
    const noun = kind === 'bus' ? 'bus' : 'train';
    const plural = evidence.held.trainCount === 1 ? '' : 's';
    const stationsList =
      evidence.coldStationNames && evidence.coldStationNames.length > 0
        ? ` near ${evidence.coldStationNames.slice(0, 3).join(', ')}`
        : '';
    return [
      `${evidence.held.trainCount} ${noun}${plural} stationary ${minutes}+ min${stationsList}.`,
    ];
  }

  return null;
}

module.exports = {
  describeBotObservation,
  describeBotResolution,
  describeBotOnset,
  describeSignal,
  describeBotEvidenceBullets,
  observationSignals,
  TRAIN_LINES,
  normalizeTrainLine,
};
