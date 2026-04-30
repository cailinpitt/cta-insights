// Verbose silent-tick log for the ghost detectors. The detector returns no
// events on most ticks, and "staying silent" by itself doesn't tell you why.
// This formats the `onDrop` payload from src/{bus,train}/ghosts.js into a
// grouped breakdown of what got filtered out.

const {
  MAX_EXPECTED_ACTIVE,
  MISSING_ABS_THRESHOLD,
  MISSING_PCT_THRESHOLD,
  MIN_OBSERVED,
} = require('../bus/ghosts');

const DROP_REASONS = {
  no_observations: 'no observations in the window',
  pattern_fetch_failed: 'pattern fetch failed (route skipped)',
  no_terminal_destination: 'no terminal destination resolved (short-turns / mid-route headsigns)',
  no_schedule: 'no scheduled service in the window',
  sparse_route: 'sparse schedule (expected < 2 vehicles)',
  expected_cap_exceeded: `schedule index implausible (expected > ${MAX_EXPECTED_ACTIVE}, treated as bad bucket)`,
  too_few_snapshots: 'too few polling snapshots in the window',
  too_few_observed: `observed below floor (<${MIN_OBSERVED} ≈ a gap, covered by the gaps bot)`,
  below_abs_threshold: `below absolute threshold (<${MISSING_ABS_THRESHOLD} vehicles missing)`,
  below_pct_threshold: `below percent threshold (<${MISSING_PCT_THRESHOLD * 100}% missing)`,
  noisy_polling: 'snapshot variance > median (likely polling blackouts, not real ghosts)',
  ramp_up_filled: 'tail of the window is filled (deficit was earlier; pipeline ramped up)',
};

// Reasons that are real ghost-candidates we deliberately chose not to post —
// worth printing each one so you can sanity-check the threshold.
const VERBOSE_REASONS = new Set([
  'below_abs_threshold',
  'below_pct_threshold',
  'noisy_polling',
  'ramp_up_filled',
  'too_few_observed',
]);

function describeDrop(d, kind) {
  const where =
    kind === 'bus'
      ? `Route ${d.route}${d.direction ? ` ${d.direction}` : ''}`
      : `${d.line}${d.scope === 'line-wide' ? ' (line-wide)' : d.trDr ? `/${d.trDr}` : ''}${d.destination ? ` → ${d.destination}` : ''}`;
  const num = (v, p = 1) => (typeof v === 'number' ? v.toFixed(p) : v);
  const bits = [];
  if (d.observedActive != null && d.expectedActive != null) {
    bits.push(`${num(d.observedActive)}/${num(d.expectedActive)} observed/expected`);
  } else if (d.expectedActive != null) {
    bits.push(`expected ${num(d.expectedActive)}`);
  }
  if (d.missing != null) bits.push(`${num(d.missing)} missing`);
  if (d.snapshots != null) bits.push(`${d.snapshots} snapshots`);
  if (d.stddev != null) bits.push(`stddev ${num(d.stddev)}`);
  if (d.tailMedian != null) bits.push(`tail median ${num(d.tailMedian)}`);
  return bits.length ? `${where} (${bits.join(', ')})` : where;
}

function shortId(d, kind) {
  if (kind === 'bus') return `${d.route}${d.direction ? `/${d.direction}` : ''}`;
  return `${d.line}${d.trDr ? `/${d.trDr}` : ''}`;
}

function logDropSummary(drops, kind, log = console.log) {
  if (!drops.length) {
    log('  (nothing was even considered — observations table empty?)');
    return;
  }
  const byReason = new Map();
  for (const d of drops) {
    if (!byReason.has(d.reason)) byReason.set(d.reason, []);
    byReason.get(d.reason).push(d);
  }
  log(`Considered ${drops.length} candidate(s); here is what was filtered:`);
  for (const [reason, list] of byReason) {
    const label = DROP_REASONS[reason] || reason;
    log(`  · [${list.length}] ${label}`);
    if (VERBOSE_REASONS.has(reason)) {
      // Sort closest-to-ghost first: highest `missing` (= biggest deficit) at
      // the top, over-served routes at the bottom. Rows without `missing`
      // sink to the end.
      const score = (d) => (typeof d.missing === 'number' ? d.missing : -Infinity);
      const sorted = [...list].sort((a, b) => score(b) - score(a));
      for (const d of sorted) log(`      - ${describeDrop(d, kind)}`);
    } else {
      const ids = list.map((d) => shortId(d, kind));
      const head = ids.slice(0, 6).join(', ');
      const tail = ids.length > 6 ? `, … (+${ids.length - 6} more)` : '';
      log(`      ${head}${tail}`);
    }
  }
}

module.exports = { logDropSummary, describeDrop, DROP_REASONS };
