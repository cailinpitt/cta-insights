function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 3-tap centered moving average; endpoints use a 2-tap window. Preserves
// monotonicity when the input is monotonic (so bunching-video track sequences
// stay non-decreasing after smoothing without needing a second clamp pass).
function smoothSeries(values) {
  const n = values.length;
  if (n <= 2) return values.slice();
  const out = new Array(n);
  out[0] = (values[0] + values[1]) / 2;
  for (let i = 1; i < n - 1; i++) {
    out[i] = (values[i - 1] + values[i] + values[i + 1]) / 3;
  }
  out[n - 1] = (values[n - 2] + values[n - 1]) / 2;
  return out;
}

module.exports = { median, smoothSeries };
