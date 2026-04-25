const WINDOW_LABELS = { week: 'this week', month: 'this month' };
const OBSERVED_FOOTER = 'Only what the bot observed; real totals may be higher.';

function titleFor(mode, window, windowLabel) {
  const emoji = mode === 'bus' ? '🚌' : '🚆';
  const label = windowLabel || WINDOW_LABELS[window] || window;
  const noun = mode === 'bus' ? 'bus' : 'train';
  return `${emoji} Chronic ${noun} bunching spots, ${label}`;
}

function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function locNouns(mode) {
  return mode === 'bus' ? ['stop', 'stops'] : ['station', 'stations'];
}

function buildPostText({ mode, window, windowLabel, points, totalIncidents }) {
  const lines = [titleFor(mode, window, windowLabel)];
  if (totalIncidents === 0) {
    lines.push('', 'No chronic bunching recorded.');
    return lines.join('\n');
  }
  const [locSing, locPlur] = locNouns(mode);
  const bunches = pluralize(totalIncidents, 'bunch', 'bunches');
  const locs = pluralize(points.length, locSing, locPlur);
  lines.push('', `${bunches} observed near ${locs}:`);
  for (const p of points.slice(0, 3)) {
    lines.push(`· ${formatBullet(p)}`);
  }
  lines.push('', OBSERVED_FOOTER);
  return lines.join('\n');
}

function formatBullet(p) {
  return p.routesLabel
    ? `${p.label} — ${p.routesLabel} (${p.count})`
    : `${p.label} (${p.count})`;
}

function buildAltText({ mode, window, windowLabel, points, totalIncidents }) {
  const subject = mode === 'bus' ? 'buses' : 'trains';
  const label = windowLabel || WINDOW_LABELS[window] || window;
  const inPhrase = windowLabel ? `from ${label}` : label;
  if (totalIncidents === 0) {
    return `Map of Chicago with no points plotted — no chronic ${subject} bunching was recorded ${inPhrase}.`;
  }
  const [locSing, locPlur] = locNouns(mode);
  const bunches = pluralize(totalIncidents, 'bunch', 'bunches');
  const locs = pluralize(points.length, locSing, locPlur);
  const top = points.slice(0, 3).map(formatBullet).join(', ');
  return `Heatmap of Chicago showing where ${subject} bunched ${inPhrase}: ${bunches} near ${locs}, with red circles sized by frequency. Top spots: ${top}.`;
}

function buildGapReplyText({ mode, window, windowLabel, entries, totalGaps, routeCount, formatRoute }) {
  const label = windowLabel || WINDOW_LABELS[window] || window;
  const lines = [`⏰ Headway gaps, ${label}`];
  if (totalGaps === 0 || entries.length === 0) {
    lines.push('', 'No gaps recorded in this window.');
    return lines.join('\n');
  }
  const [nounSing, nounPlur] = mode === 'bus' ? ['route', 'routes'] : ['line', 'lines'];
  const gaps = pluralize(totalGaps, 'gap', 'gaps');
  const routes = pluralize(routeCount ?? entries.length, nounSing, nounPlur);
  lines.push('', `${gaps} observed across ${routes}. Where service was thinnest:`);
  for (const e of entries.slice(0, 3)) {
    lines.push(`· ${formatRoute ? formatRoute(e.route) : e.route} (${e.count})`);
  }
  lines.push('', OBSERVED_FOOTER);
  return lines.join('\n');
}

function buildGapReplyAlt({ mode, window, windowLabel, entries, totalGaps, formatRoute }) {
  const label = windowLabel || WINDOW_LABELS[window] || window;
  const inPhrase = windowLabel ? `from ${label}` : label;
  const subject = mode === 'bus' ? 'bus routes' : 'train lines';
  if (totalGaps === 0 || entries.length === 0) {
    return `Chart showing no headway gaps recorded across ${subject} ${inPhrase}.`;
  }
  const top = entries.slice(0, 3)
    .map((e) => `${formatRoute ? formatRoute(e.route) : e.route} (${e.count})`)
    .join(', ');
  return `Horizontal bar chart of headway gaps by ${mode === 'bus' ? 'route' : 'line'} ${inPhrase}: ${totalGaps} total gaps. Worst: ${top}.`;
}

module.exports = {
  buildPostText,
  buildAltText,
  buildGapReplyText,
  buildGapReplyAlt,
  titleFor,
};
