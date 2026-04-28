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

/**
 * Like buildRollupPost, but instead of truncating with "…and N more" when
 * lines overflow, return an array of post bodies suitable for threading.
 * `header` and optional `footer` go on the first post; continuations are
 * just lines in worst-first order. Returns `null` if even a single line
 * can't be placed in the first post.
 */
function buildRollupThread(header, lines, { footer = null, maxChars = POST_MAX_CHARS } = {}) {
  if (lines.length === 0) return null;
  const posts = [];
  const footerSuffix = footer ? `\n\n${footer}` : '';

  // First post: header + as many lines as fit + footer (if supplied).
  let firstCount = 0;
  for (let k = lines.length; k >= 1; k--) {
    const candidate = `${header}\n\n${lines.slice(0, k).join('\n')}${footerSuffix}`;
    if (graphemeLength(candidate) <= maxChars) {
      firstCount = k;
      posts.push(candidate);
      break;
    }
  }
  if (firstCount === 0) return null;

  // Continuation posts: pack remaining lines greedily into bodies that fit
  // on their own. No header repetition — they show up threaded under the
  // first post, where the context is already set.
  let i = firstCount;
  while (i < lines.length) {
    let k = i;
    while (k < lines.length) {
      const candidate = lines.slice(i, k + 1).join('\n');
      if (graphemeLength(candidate) > maxChars) break;
      k++;
    }
    if (k === i) {
      // A single line exceeds maxChars on its own — skip it. Lines are
      // worst-first so the dropped entry is the least severe still pending.
      i++;
      continue;
    }
    posts.push(lines.slice(i, k).join('\n'));
    i = k;
  }
  return posts;
}

module.exports = { buildRollupPost, buildRollupThread, POST_MAX_CHARS, graphemeLength };
