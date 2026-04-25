// 300-grapheme cap. Emoji = multi-codeunit single-grapheme, so use Segmenter not .length.
const POST_MAX_CHARS = 300;

const _segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
function graphemeLength(s) {
  let n = 0;
  for (const _ of _segmenter.segment(s)) n++;
  return n;
}

/**
 * Build a rollup post body that fits under Bluesky's limit. Lines are assumed
 * worst-first. If everything fits unadorned we emit the full rollup; otherwise
 * we keep the longest prefix that fits alongside a "…and N more routes" tail.
 * Returns `null` if even one line + a tail won't fit in `maxChars`.
 */
function buildRollupPost(header, lines, maxChars = POST_MAX_CHARS) {
  if (lines.length === 0) return null;
  const moreTail = (n) => `\n…and ${n} more route${n === 1 ? '' : 's'}`;

  const full = `${header}\n\n${lines.join('\n')}`;
  if (graphemeLength(full) <= maxChars) return full;

  for (let k = lines.length - 1; k >= 1; k--) {
    const dropped = lines.length - k;
    const text = `${header}\n\n${lines.slice(0, k).join('\n')}${moreTail(dropped)}`;
    if (graphemeLength(text) <= maxChars) return text;
  }
  return null;
}

module.exports = { buildRollupPost, POST_MAX_CHARS, graphemeLength };
