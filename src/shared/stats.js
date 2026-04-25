function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 3-tap centered MA, 2-tap at endpoints. Preserves monotonicity so video
// track sequences stay non-decreasing after smoothing.
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
