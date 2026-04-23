const sharp = require('sharp');
const { xmlEscape } = require('./common');

// Square canvas — Bluesky crops/distorts non-square images in the feed.
const SIZE = 1200;
const BG = '#1a1a1d';
const GRID = '#2d2d33';
const TEXT = '#f5f5f7';
const SUBTEXT = '#9a9aa2';

const PAD_X = 80;
const PAD_TOP = 90;
const PAD_BOTTOM = 110;
const TITLE_SIZE = 52;
const SUBTITLE_SIZE = 26;
const BAR_LABEL_W = 220;
const COUNT_LABEL_W = 120;
const BAR_GAP = 18;

const WINDOW_LABELS = { week: 'this week', month: 'this month' };

function renderGapChart({ kind, entries, window, windowLabel = null, lineNames = null, lineColors = null, totalGaps, formatRoute = null }) {
  const title = kind === 'train' ? '⏰ Headway gaps by line' : '⏰ Headway gaps by route';
  const label = windowLabel || WINDOW_LABELS[window] || window;
  const subtitle = `${totalGaps} gap${totalGaps === 1 ? '' : 's'}, ${label}`;

  const rows = entries.length;
  const chartTop = PAD_TOP + TITLE_SIZE + 20 + SUBTITLE_SIZE + 40;
  const chartBottom = SIZE - PAD_BOTTOM;
  const chartHeight = chartBottom - chartTop;
  const rowHeight = rows > 0 ? (chartHeight - BAR_GAP * (rows - 1)) / rows : 0;
  const barX = PAD_X + BAR_LABEL_W;
  const barMaxW = SIZE - PAD_X - barX - COUNT_LABEL_W;
  const maxCount = Math.max(1, ...entries.map((e) => e.count));

  const bars = entries.map((e, i) => {
    const y = chartTop + i * (rowHeight + BAR_GAP);
    const w = Math.max(6, (e.count / maxCount) * barMaxW);
    const color = kind === 'train' && lineColors?.[e.route]
      ? `#${lineColors[e.route]}`
      : '#ff2a6d';
    const labelText = formatRoute
      ? formatRoute(e.route)
      : (kind === 'train' && lineNames?.[e.route] ? lineNames[e.route] : e.route);
    const labelY = y + rowHeight / 2 + 10;
    const countX = barX + w + 16;
    const barRadius = Math.min(10, rowHeight / 2);
    return [
      `<text x="${barX - 16}" y="${labelY}" fill="${TEXT}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600">${xmlEscape(labelText)}</text>`,
      `<rect x="${barX}" y="${y}" width="${w}" height="${rowHeight}" rx="${barRadius}" fill="${color}"/>`,
      `<text x="${countX}" y="${labelY}" fill="${TEXT}" text-anchor="start" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700">${e.count}</text>`,
    ].join('');
  }).join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>
    <text x="${PAD_X}" y="${PAD_TOP + TITLE_SIZE}" fill="${TEXT}" font-family="Helvetica, Arial, sans-serif" font-size="${TITLE_SIZE}" font-weight="700">${xmlEscape(title)}</text>
    <text x="${PAD_X}" y="${PAD_TOP + TITLE_SIZE + 20 + SUBTITLE_SIZE}" fill="${SUBTEXT}" font-family="Helvetica, Arial, sans-serif" font-size="${SUBTITLE_SIZE}" font-weight="500">${xmlEscape(subtitle)}</text>
    <line x1="${barX}" y1="${chartTop - 10}" x2="${barX}" y2="${chartBottom + 10}" stroke="${GRID}" stroke-width="2"/>
    ${bars}
  </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

module.exports = { renderGapChart };
