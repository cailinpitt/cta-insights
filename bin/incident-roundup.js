#!/usr/bin/env node
// Multi-signal correlation roundup: when several detectors have sub-threshold
// signals on the same line/route within a 30-min window, post a single
// text-only rollup acknowledging that something is up. Catches incidents
// where no individual gate fires but the union of signals is loud (e.g. the
// 2026-05-03 Red incident: gap suppressed by daily cap, ghost 0.5 below
// threshold, pulse on a small mid-Loop slice).
//
// Operates kind-agnostically: reads meta_signals rows for both kind='train'
// and kind='bus' and posts using the appropriate label.

require('../src/shared/env');

const { setup, runBin } = require('../src/shared/runBin');
const { ALL_LINES, lineLabel } = require('../src/train/api');
const { allRoutes: busRoutes, names: busRouteNames } = require('../src/bus/routes');
const { getRecentMetaSignals, getDb } = require('../src/shared/history');
const { acquireCooldown } = require('../src/shared/state');
const { loginAlerts, postText } = require('../src/shared/bluesky');

const WINDOW_MS = 30 * 60 * 1000;
const SCORE_THRESHOLD = 2.0;
const ROUNDUP_COOLDOWN_MS = 60 * 60 * 1000;
const DRY_RUN = process.env.ROUNDUP_DRY_RUN === '1' || process.argv.includes('--dry-run');

function scoreSignals(signals) {
  const bySource = new Map();
  for (const s of signals) {
    const cur = bySource.get(s.source) || 0;
    if (s.severity > cur) bySource.set(s.source, s.severity);
  }
  let total = 0;
  for (const v of bySource.values()) total += v;
  return { total, bySource };
}

function describeSignal(s, kind) {
  let detail = {};
  try {
    detail = s.detail ? JSON.parse(s.detail) : {};
  } catch (_e) {
    detail = {};
  }
  if (s.source === 'gap') {
    return `· ${detail.ratio || '?'}x gap (${detail.suppressed || 'recorded'})`;
  }
  if (s.source === 'ghost') {
    const noun = kind === 'bus' ? 'buses' : 'trains';
    return `· ${Math.round((detail.missing || 0) * 10) / 10} of ${Math.round((detail.expected || 0) * 10) / 10} ${noun} missing`;
  }
  if (s.source === 'bunching') {
    return `· bunching near-miss (${detail.vehicles || '?'} buses, ${detail.suppressed || 'recorded'})`;
  }
  if (s.source === 'pulse-cold' || s.source === 'pulse-held') {
    const seg =
      detail.fromStation && detail.toStation ? ` ${detail.fromStation} → ${detail.toStation}` : '';
    return `· pulse near-miss${seg}`;
  }
  return `· ${s.source}`;
}

function buildRoundupText({ kind, line, name, signals }) {
  const label = kind === 'bus' ? `#${line} ${name || line}` : `${lineLabel(line)} Line`;
  const lines = [`⚠ ${label} · multiple service signals`];
  const seen = new Set();
  for (const s of signals) {
    const key = s.source;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(describeSignal(s, kind));
  }
  lines.push('');
  lines.push(
    'None individually crossed its alert threshold; together they suggest service is degraded.',
  );
  return lines.join('\n');
}

async function processKind({ kind, identifiers, getName, agentGetter, now }) {
  for (const id of identifiers) {
    const signals = getRecentMetaSignals({ kind, line: id, withinMs: WINDOW_MS }, now);
    if (signals.length === 0) continue;
    const { total, bySource } = scoreSignals(signals);
    const label = kind === 'bus' ? `bus/${id}` : lineLabel(id);
    if (total < SCORE_THRESHOLD) {
      console.log(
        `roundup: ${label} score=${total.toFixed(2)} sources=${[...bySource.keys()].join(',')} below threshold`,
      );
      continue;
    }
    const cooldownKey = `${kind}_roundup_${id}`;
    const text = buildRoundupText({ kind, line: id, name: getName(id), signals });
    if (DRY_RUN) {
      console.log(`--- DRY RUN roundup ${label} score=${total.toFixed(2)} ---\n${text}`);
      continue;
    }
    if (!acquireCooldown(cooldownKey, now, ROUNDUP_COOLDOWN_MS)) {
      console.log(`roundup: ${label} cooldown active, skipping`);
      continue;
    }
    try {
      const a = await agentGetter();
      const result = await postText(a, text, null);
      console.log(`Posted roundup ${label}: ${result.url}`);
      const ids = signals.map((s) => s.id);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        getDb()
          .prepare(`UPDATE meta_signals SET posted = 1 WHERE id IN (${placeholders})`)
          .run(...ids);
      }
    } catch (e) {
      console.error(`roundup post failed for ${label}: ${e.stack || e.message}`);
    }
  }
}

async function main() {
  setup();
  const now = Date.now();

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  await processKind({
    kind: 'train',
    identifiers: ALL_LINES,
    getName: () => null,
    agentGetter,
    now,
  });
  await processKind({
    kind: 'bus',
    identifiers: busRoutes,
    getName: (route) => busRouteNames[route] || null,
    agentGetter,
    now,
  });
}

module.exports = { scoreSignals, buildRoundupText, describeSignal };

if (require.main === module) runBin(main);
