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
const {
  getRecentMetaSignals,
  getDb,
  recordRoundupAnchor,
  listUnresolvedRoundupAnchors,
  updateRoundupClearTicks,
  markRoundupResolved,
} = require('../src/shared/history');
const { acquireCooldown } = require('../src/shared/state');
const { loginAlerts, postText, resolveReplyRef } = require('../src/shared/bluesky');

const WINDOW_MS = 30 * 60 * 1000;
const SCORE_THRESHOLD = 1.75;
// Hysteresis below the firing threshold: only count a tick as "clear" when
// the rolling score is comfortably under the bar so a flapping signal near
// the threshold doesn't yo-yo into a resolution post.
const RESOLVE_SCORE_THRESHOLD = 1.0;
// Tick cadence is */5 (5 min); 3 ticks = ~15 min of sustained quiet before
// posting a resolution. Mirrors the consecutive-tick gate train pulse uses
// for its own clear/resolve logic.
const RESOLVE_MIN_CLEAR_TICKS = 3;
const ROUNDUP_COOLDOWN_MS = 60 * 60 * 1000;
// Per-source persistence bonus: a sub-threshold signal that keeps re-firing
// across ticks is more credible than a one-off. Each repeat past the first
// adds PERSISTENCE_BONUS_PER_REPEAT, capped at PERSISTENCE_BONUS_CAP so a
// flapping single source can't run away with the score on its own.
const PERSISTENCE_BONUS_PER_REPEAT = 0.15;
const PERSISTENCE_BONUS_CAP = 0.5;
const DRY_RUN = process.env.ROUNDUP_DRY_RUN === '1' || process.argv.includes('--dry-run');

function scoreSignals(signals) {
  const bySource = new Map();
  for (const s of signals) {
    const cur = bySource.get(s.source) || { severity: 0, count: 0 };
    bySource.set(s.source, {
      severity: Math.max(cur.severity, s.severity),
      count: cur.count + 1,
    });
  }
  let total = 0;
  for (const v of bySource.values()) {
    const bonus = Math.min(PERSISTENCE_BONUS_CAP, PERSISTENCE_BONUS_PER_REPEAT * (v.count - 1));
    v.contribution = v.severity + bonus;
    v.bonus = bonus;
    total += v.contribution;
  }
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
    const ratio = Number.isFinite(detail.ratio) ? `${detail.ratio.toFixed(1)}` : '?';
    const noun = kind === 'bus' ? 'buses' : 'trains';
    return `· wait between ${noun} is ${ratio}x longer than scheduled`;
  }
  if (s.source === 'ghost') {
    const noun = kind === 'bus' ? 'buses' : 'trains';
    // Round to whole vehicles — "7.3 of 18.3 buses" reads as nonsense to a
    // rider; the underlying schedule numbers are activeByHour averages, not
    // counts, but the reader-facing prose should look like a count.
    const missing = Math.max(0, Math.round(detail.missing || 0));
    const expected = Math.max(0, Math.round(detail.expected || 0));
    return `· ${missing} of ${expected} ${noun} missing this past hour`;
  }
  if (s.source === 'bunching') {
    const n = detail.vehicles || '?';
    const noun = kind === 'bus' ? 'buses' : 'trains';
    return `· ${n} ${noun} recently bunched together`;
  }
  if (s.source === 'pulse-cold' || s.source === 'pulse-held') {
    const seg =
      detail.fromStation && detail.toStation ? ` ${detail.fromStation} → ${detail.toStation}` : '';
    const noun = kind === 'bus' ? 'buses' : 'trains';
    // Pre-threshold candidates: blackout (cold) = no vehicles seen, held =
    // vehicles seen but stuck. Couched as "possible/may" because they
    // haven't yet hit the consecutive-tick bar for a standalone post.
    if (s.source === 'pulse-held') return `· ${noun} appear stuck in place${seg}`;
    return `· possible service gap forming${seg}`;
  }
  return `· ${s.source}`;
}

function buildRoundupText({ kind, line, name, signals }) {
  const label = kind === 'bus' ? `#${line} ${name || line}` : `${lineLabel(line)} Line`;
  const prefix = kind === 'bus' ? '🚌⚠️' : '🚇⚠️';
  const lines = [`${prefix} ${label} · multiple signals`];
  const seen = new Set();
  for (const s of signals) {
    const key = s.source;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(describeSignal(s, kind));
  }
  lines.push('');
  lines.push('Multiple signals suggest service may be degraded.');
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
      // Anchor the rollup so the related-quotes sweep can attach
      // subsequent on-route bunching/gap posts to this thread.
      recordRoundupAnchor({
        kind,
        line: id,
        postUri: result.uri,
        postCid: result.cid,
        ts: now,
        signals: signals.map((s) => s.source),
      });
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

function buildResolutionText({ kind, line, name }) {
  const label = kind === 'bus' ? `#${line} ${name || line}` : `${lineLabel(line)} Line`;
  const prefix = kind === 'bus' ? '🚌✅' : '🚇✅';
  return `${prefix} ${label} · service signals back to normal`;
}

async function sweepResolutions({ kind, getName, agentGetter, now }) {
  for (const row of listUnresolvedRoundupAnchors(kind, now)) {
    const signals = getRecentMetaSignals({ kind, line: row.line, withinMs: WINDOW_MS }, now);
    const { total } = scoreSignals(signals);
    const label = kind === 'bus' ? `bus/${row.line}` : lineLabel(row.line);
    if (total >= RESOLVE_SCORE_THRESHOLD) {
      // Score still elevated → reset the consecutive-clear counter.
      if (row.clear_ticks !== 0) updateRoundupClearTicks(row.id, 0);
      continue;
    }
    const newClearTicks = (row.clear_ticks || 0) + 1;
    if (newClearTicks < RESOLVE_MIN_CLEAR_TICKS) {
      updateRoundupClearTicks(row.id, newClearTicks);
      console.log(
        `roundup-resolve: ${label} clear tick ${newClearTicks}/${RESOLVE_MIN_CLEAR_TICKS} (score=${total.toFixed(2)})`,
      );
      continue;
    }
    const text = buildResolutionText({ kind, line: row.line, name: getName(row.line) });
    if (DRY_RUN) {
      console.log(`--- DRY RUN roundup-resolve ${label} ---\n${text}`);
      continue;
    }
    try {
      const a = await agentGetter();
      const replyRef = await resolveReplyRef(a, row.post_uri);
      if (!replyRef) {
        // Source post is gone (deleted/rotated). Mark resolved with no
        // reply so we stop hitting the API every tick.
        markRoundupResolved(row.id, null, now);
        console.log(`roundup-resolve: ${label} source post missing — marked resolved silently`);
        continue;
      }
      const result = await postText(a, text, replyRef);
      markRoundupResolved(row.id, result.uri, now);
      console.log(`Posted roundup resolution ${label}: ${result.url}`);
    } catch (e) {
      console.error(`roundup-resolve post failed for ${label}: ${e.stack || e.message}`);
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

  // Resolution sweep runs after the firing pass: any unresolved roundup
  // whose underlying signals have died down for ≥3 consecutive ticks gets
  // a "back to normal" reply walked to the latest leaf of the thread.
  await sweepResolutions({
    kind: 'train',
    getName: () => null,
    agentGetter,
    now,
  });
  await sweepResolutions({
    kind: 'bus',
    getName: (route) => busRouteNames[route] || null,
    agentGetter,
    now,
  });
}

module.exports = {
  scoreSignals,
  buildRoundupText,
  describeSignal,
  buildResolutionText,
  sweepResolutions,
};

if (require.main === module) runBin(main);
