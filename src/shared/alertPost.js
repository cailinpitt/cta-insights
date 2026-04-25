// Post text/alt builders for CTA alert-sourced posts.
//
// Two shapes:
//   1) Rich: we successfully extracted "between X and Y" stations and the
//      station names resolve against trainStations.json. The caller renders
//      the map via src/map/disruption.js and posts with image.
//   2) Plain: extraction failed. Caller posts text-only.
//
// Post text always:
//   - Leads with a severity emoji + headline
//   - Credits CTA
//   - Includes the alert URL when present (gives readers the official source)
//
// Keep bodies short — Bluesky caps at 300 graphemes.

const { graphemeLength } = require('./post');
const { LINE_NAMES, LINE_EMOJI } = require('../train/api');

const EMOJI_BUS = '🚌';
const EMOJI_WARN = '⚠';
const EMOJI_RESOLVED = '✅';

function buildAlertPostText({ alert, kind, disruption, shorten = true }) {
  const prefix = kind === 'train' ? EMOJI_WARN : `${EMOJI_BUS}${EMOJI_WARN}`;
  const head = alert.headline || 'Service alert';

  const parts = [`${prefix} ${head}`];
  const body = alert.shortDescription || alert.fullDescription;
  if (body) {
    parts.push('');
    parts.push(shorten ? truncateSentence(body, 200) : body);
  }
  parts.push('');
  parts.push('Per CTA. Check transitchicago.com for updates.');

  let text = parts.join('\n');
  if (graphemeLength(text) <= 300) return text;

  // Fallback: drop the body and just post the headline + footer.
  const compact = `${prefix} ${head}\n\nPer CTA. transitchicago.com`;
  return compact;
}

function buildAlertAltText({ alert, kind, disruption }) {
  if (disruption) {
    const lineName = LINE_NAMES[disruption.line] || disruption.line;
    return `Map of the ${lineName} Line showing the segment between ${disruption.suspendedSegment.from} and ${disruption.suspendedSegment.to} dimmed to indicate CTA-reported service impact.`;
  }
  return alert.headline || 'CTA service alert';
}

function buildResolutionReplyText({ alert, kind }) {
  const prefix = kind === 'train' ? EMOJI_RESOLVED : `${EMOJI_BUS}${EMOJI_RESOLVED}`;
  const head = alert.headline || 'Service alert';
  return `${prefix} CTA has cleared: ${truncateSentence(head, 240)}`;
}

function truncateSentence(s, maxChars) {
  if (!s) return '';
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  if (lastStop > maxChars * 0.5) return cut.slice(0, lastStop + 1);
  return cut.replace(/\s+\S*$/, '') + '…';
}

module.exports = {
  buildAlertPostText,
  buildAlertAltText,
  buildResolutionReplyText,
};
