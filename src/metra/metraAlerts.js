// Significance gate + post text for Metra's GTFS-realtime service alerts. The
// republish path is the Metra analog of src/shared/ctaAlerts.js, but the input is
// already structured (parsed by src/metra/api.js#parseAlert) so there's no XML
// quirk handling. Pure functions — bin/metra/alerts.js wires them to the feed,
// the DB, and Bluesky.
//
// IMPORTANT: Metra commonly sets `effect = UNKNOWN_EFFECT` on real alerts (every
// alert in the 2026-06-09 snapshot did), so we CAN'T gate on `effect` alone. The
// gate is primarily keyword-driven over the header + description, with the
// structured `effect` only used as a strong *admit* signal when Metra does set it.
// Like the CTA gate, this errs toward silence — a missed alert is recoverable;
// spamming followers with ADA/construction notices trains them to ignore the feed.

const { graphemeLength } = require('../shared/post');
const { ALL_LINES, MODE_EMOJI } = require('./lines');

const EMOJI_WARN = '⚠️';

// Real service problems worth a post. Cancellations are the headline Metra term
// (a scheduled train annulled), alongside delays, suspensions, and substitutions.
const MAJOR_PATTERNS = [
  /\bcancell?ed\b/i,
  /\bcancellations?\b/i,
  /\bannull?ed\b/i,
  /\bno\s+(train|service|inbound|outbound)\b/i,
  /\bnot\s+running\b/i,
  /\bsuspend(ed|ing|s)?\b/i,
  /\bwill\s+not\s+(operate|run|stop)\b/i,
  // Delays only count when qualified — a bare "minor delays during construction"
  // line shouldn't post. Require a magnitude ("25 minutes late") or an explicit
  // severity word; bare "delay" is intentionally NOT major.
  /\b\d+\s*(\+|or\s+more)?\s*minutes?\s+(late|behind|delay)/i,
  /\b(significant|major|extensive|lengthy|substantial|lengthy)\s+delays?\b/i,
  /\bshuttle\b/i,
  /\bbus(es)?\b.*\b(substitut|bridge|replac)/i,
  /\bsignal\s+(problem|issue|malfunction|trouble)/i,
  /\bmechanical\b/i,
  /\bdisabled\s+train\b/i,
  /\bpolice\s+activity\b/i,
  /\btrespasser\b/i,
  /\bstruck\b/i,
  /\bservice\s+(disrupt|halt|impact)/i,
  // "alternate transportation/train" signals a real substitution; "alternate
  // boarding stations" is benign ADA/construction phrasing, so it's excluded.
  /\balternate\s+(train|transportation)\b/i,
];

// Notices that look alert-shaped but aren't a service problem riders need pushed.
// A MAJOR hit overrides a MINOR hit (e.g. "trains cancelled due to construction"
// still posts), so these only veto when nothing major is also present.
const MINOR_PATTERNS = [
  /\bada\b/i,
  /\baccessib/i,
  /\belevator\b/i,
  /\bescalator\b/i,
  /\bparking\b/i,
  /\bbi(cycle|ke)s?\b/i,
  /\b(grand\s+)?opening|opening\s+ceremony\b/i,
  /\bcelebrat|festival|fair\b/i,
  /\bsurvey\b/i,
  /\bnew\s+schedule|schedule\s+(change|update|now|pdf)|timetable\b/i,
  /\bticket(ing)?\s+(app|machine|office|window)/i,
  /\bentrance\b/i,
  /\bstation\s+(improv|renovat|upgrade)/i,
  /\bplatform\s+(work|improv)/i,
  /\bconstruction\b/i,
  /\btemporar(y|ily)\b/i,
];

// Structured effects that always admit when Metra bothers to set them (rare —
// usually UNKNOWN_EFFECT). NO_DATA-style or UNKNOWN values fall through to keywords.
const STRONG_EFFECTS = new Set(['NO_SERVICE', 'SIGNIFICANT_DELAYS', 'REDUCED_SERVICE']);

function alertText(alert) {
  return [alert.header, alert.description].filter(Boolean).join(' \n ');
}

// Which Metra lines an alert touches, plus whether it's an agency-wide notice.
// `lines` are the recognized route_ids from informed_entity; `agencyWide` is true
// when the only scoping is agency-level (e.g. a system-wide weather advisory).
function alertRelevance(alert) {
  const lines = [];
  let sawAgency = false;
  for (const e of alert.informedEntities || []) {
    if (e.routeId && ALL_LINES.includes(e.routeId)) {
      if (!lines.includes(e.routeId)) lines.push(e.routeId);
    } else if (e.agencyId) {
      sawAgency = true;
    }
  }
  const agencyWide = lines.length === 0 && sawAgency;
  return { lines, agencyWide, relevant: lines.length > 0 || agencyWide };
}

// True when the alert describes a real service problem on a tracked line (or
// system-wide). Strong structured effect always admits; otherwise keyword-driven
// with minor-wins veto (a MAJOR hit overrides a MINOR hit).
function isSignificantMetraAlert(alert) {
  if (!alertRelevance(alert).relevant) return false;
  if (alert.effect && STRONG_EFFECTS.has(alert.effect)) return true;
  const text = alertText(alert).toLowerCase();
  if (!text) return false;
  const hasMajor = MAJOR_PATTERNS.some((re) => re.test(text));
  const hasMinor = MINOR_PATTERNS.some((re) => re.test(text));
  if (hasMinor && !hasMajor) return false;
  return hasMajor;
}

// Trim to a sentence boundary at/under maxChars; falls back to a hard cut with an
// ellipsis. Mirrors alertPost.js#truncateSentence so the two read the same.
function truncateSentence(s, maxChars) {
  if (!s || s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars);
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (lastStop > maxChars * 0.5) return slice.slice(0, lastStop + 1);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > 0 ? lastSpace : maxChars)}…`;
}

// Bluesky post text for a republished Metra alert. Same shape as the CTA alert
// post (header + truncated body + provenance), Metra-branded. Falls back to a
// header-only form when the full text exceeds Bluesky's 300-grapheme limit.
function buildMetraAlertText(alert) {
  const head = alert.header || 'Service alert';
  const prefix = `${MODE_EMOJI}${EMOJI_WARN}`;
  const parts = [`${prefix} ${head}`];
  if (alert.description) {
    parts.push('');
    parts.push(truncateSentence(alert.description, 200));
  }
  parts.push('');
  parts.push('Per Metra. Check metra.com for updates.');
  const text = parts.join('\n');
  if (graphemeLength(text) <= 300) return text;
  return `${prefix} ${head}\n\nPer Metra. metra.com`;
}

// Threaded reply text when an alert drops out of the feed (Metra-side "resolved").
// The header is the original alert's, so the reply reads as a clear of that post.
function buildMetraResolutionText(header) {
  const head = header ? truncateSentence(header, 180) : 'Service alert';
  return `${MODE_EMOJI}✅ Metra reports this is resolved:\n\n${head}`;
}

// Threaded reply that closes a single-train cancellation once its scheduled
// departure has passed. Deliberately NOT the "resolved" reply: a cancelled train
// doesn't un-cancel, so we never imply service was restored — just a neutral note
// that the train's slot has elapsed. The bin attaches a link card to the incident's
// archive page (with the neutral buildMetraCloseCardTitle), like the resolution reply.
function buildMetraCancellationCloseText() {
  return "ℹ️ This train's scheduled departure time has passed.";
}

// Threaded reply that closes a single-train delay once the train should have
// finished its run (final scheduled arrival + the announced delay + grace). Like
// the cancellation close, this is deliberately NOT the "✅ resolved" reply: Metra
// hasn't reported it cleared — we INFERRED, from the timetable and the stated delay,
// that the train has reached its destination by now. Neutral, honest, no claim that
// service was restored. The bin attaches a link card to the incident's archive page
// (with the neutral buildMetraCloseCardTitle), like the resolution reply.
function buildMetraDelayCloseText() {
  return 'ℹ️ Based on the schedule and the reported delay, this train should have reached its destination by now.';
}

// Clean link-card headline for the resolution reply — no leading emoji, points
// at the incident's archive page on chicagotransitalerts.app. Mirrors CTA's
// buildResolutionReplyCardTitle so both accounts read consistently.
function buildMetraResolutionCardTitle(header) {
  const head = header ? truncateSentence(header, 240) : 'Service alert';
  return `Metra reports this is resolved: ${head}`;
}

// Link-card headline for a single-train cancellation/delay close reply. Like the
// resolution card it points at the incident's archive page, but it makes NO
// "resolved" claim — these closes are deliberately neutral (a cancelled train
// doesn't un-cancel; a delayed one we only infer has arrived), so the card just
// carries the incident's own headline.
function buildMetraCloseCardTitle(header) {
  return header ? truncateSentence(header, 260) : 'Metra service alert';
}

module.exports = {
  isSignificantMetraAlert,
  alertRelevance,
  buildMetraAlertText,
  buildMetraResolutionText,
  buildMetraResolutionCardTitle,
  buildMetraCloseCardTitle,
  buildMetraCancellationCloseText,
  buildMetraDelayCloseText,
  MAJOR_PATTERNS,
  MINOR_PATTERNS,
};
