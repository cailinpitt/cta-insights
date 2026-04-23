// Post builder for heatmap rollups. Single module for both bus and train
// since the structure is identical; only the noun ("stops" vs "stations")
// and emoji differ.

const WINDOW_LABELS = { week: 'this week', month: 'this month' };

function titleFor(mode, window) {
  const emoji = mode === 'bus' ? '🚌' : '🚆';
  const label = WINDOW_LABELS[window] || window;
  const noun = mode === 'bus' ? 'bus' : 'train';
  return `${emoji} Chronic ${noun} bunching spots, ${label}`;
}

function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function locNouns(mode) {
  return mode === 'bus' ? ['stop', 'stops'] : ['station', 'stations'];
}

function buildPostText({ mode, window, points, totalIncidents }) {
  const lines = [titleFor(mode, window)];
  if (totalIncidents === 0) {
    lines.push('', 'No chronic bunching recorded.');
    return lines.join('\n');
  }
  const [locSing, locPlur] = locNouns(mode);
  const bunches = pluralize(totalIncidents, 'bunch', 'bunches');
  const locs = pluralize(points.length, locSing, locPlur);
  lines.push('', `${bunches} near ${locs}:`);
  for (const p of points.slice(0, 3)) {
    lines.push(`· ${formatBullet(p)}`);
  }
  return lines.join('\n');
}

function formatBullet(p) {
  return p.routesLabel
    ? `${p.label} — ${p.routesLabel} (${p.count})`
    : `${p.label} (${p.count})`;
}

function buildAltText({ mode, window, points, totalIncidents }) {
  const subject = mode === 'bus' ? 'buses' : 'trains';
  const label = WINDOW_LABELS[window] || window;
  if (totalIncidents === 0) {
    return `Map of Chicago with no points plotted — no chronic ${subject} bunching was recorded ${label}.`;
  }
  const [locSing, locPlur] = locNouns(mode);
  const bunches = pluralize(totalIncidents, 'bunch', 'bunches');
  const locs = pluralize(points.length, locSing, locPlur);
  const top = points.slice(0, 3).map(formatBullet).join(', ');
  return `Heatmap of Chicago showing where ${subject} bunched ${label}: ${bunches} near ${locs}, with red circles sized by frequency. Top spots: ${top}.`;
}

module.exports = { buildPostText, buildAltText, titleFor };
