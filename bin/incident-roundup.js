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
const {
  loginAlerts,
  postText,
  postTextWithLinkCard,
  resolveReplyRef,
} = require('../src/shared/bluesky');
const { LINE_TO_RAIL_ROUTE } = require('../src/shared/ctaAlerts');
const { resolvedEventLink } = require('../src/shared/eventLink');

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
// Standalone admit path: a posted ghost loud enough that the multi-source
// requirement would penalize sparse-failure-mode routes (e.g. low-frequency
// buses where bunching/gap geometrically can't co-fire). Threshold is 2× the
// post bar (25% missing) — a majority of scheduled service is gone.
const GHOST_OVERRIDE_PCT = 0.5;
const GHOST_OVERRIDE_MIN_MISSING = 3;
const DRY_RUN = process.env.ROUNDUP_DRY_RUN === '1' || process.argv.includes('--dry-run');

function ghostOverrideQualifies(signal) {
  if (signal.source !== 'ghost') return false;
  let detail = {};
  try {
    detail = signal.detail ? JSON.parse(signal.detail) : {};
  } catch (_e) {
    return false;
  }
  const missing = Number(detail.missing);
  const expected = Number(detail.expected);
  if (!Number.isFinite(missing) || !Number.isFinite(expected) || expected <= 0) return false;
  if (missing < GHOST_OVERRIDE_MIN_MISSING) return false;
  return missing / expected >= GHOST_OVERRIDE_PCT;
}

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
  const ghostOverride = signals.some(ghostOverrideQualifies);
  return { total, bySource, ghostOverride };
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
    return `· one gap between ${noun} is ${ratio}x the scheduled wait`;
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

// For dedup, "worst" is source-specific. Ghost severity is capped at 1.0 once
// posted, so picking by `severity` alone treats NB and SB as a tie and picks
// whichever sorted first — that's how we ended up reporting 3/9 SB on #151
// when 5/8 NB was the actual story. For ghost we re-derive the missing/
// expected ratio from `detail`; for other sources the stored severity is
// already proportional to the underlying metric.
function severityFor(s) {
  if (s.source === 'ghost') {
    try {
      const d = s.detail ? JSON.parse(s.detail) : {};
      const missing = Number(d.missing);
      const expected = Number(d.expected);
      if (Number.isFinite(missing) && expected > 0) return missing / expected;
    } catch (_e) {}
    return 0;
  }
  return Number.isFinite(s.severity) ? s.severity : 0;
}

function buildRoundupText({ kind, line, name, signals }) {
  const label = kind === 'bus' ? `#${line} ${name || line}` : `${lineLabel(line)} Line`;
  const prefix = kind === 'bus' ? '🚌⚠️' : '🚇⚠️';
  // One bullet per source, picking the most severe instance per source so a
  // less-affected direction can't shadow a worse one.
  const bestBySource = new Map();
  for (const s of signals) {
    const cur = bestBySource.get(s.source);
    if (!cur || severityFor(s) > severityFor(cur)) bestBySource.set(s.source, s);
  }
  const bullets = [...bestBySource.values()].map((s) => describeSignal(s, kind));
  const multi = bullets.length > 1;
  const header = `${prefix} ${label} · ${multi ? 'multiple signals' : 'signal'}`;
  const footer = multi
    ? 'Multiple signals suggest service may be degraded.'
    : 'Signal suggests service may be degraded.';
  return [header, ...bullets, '', footer].join('\n');
}

async function processKind({ kind, identifiers, getName, agentGetter, now }) {
  for (const id of identifiers) {
    const signals = getRecentMetaSignals({ kind, line: id, withinMs: WINDOW_MS }, now);
    if (signals.length === 0) continue;
    const { total, bySource, ghostOverride } = scoreSignals(signals);
    const label = kind === 'bus' ? `bus/${id}` : lineLabel(id);
    // If a ghost-override standalone post already went out on this route in
    // the window, the roundup would just duplicate it — usually with a less-
    // severe headline number, since ghost meta_signals fan out per direction
    // and the roundup picks one source-bullet. Better to stay silent and let
    // the ghost post own the thread.
    const ghostOverrideAlreadyPosted = signals.some(
      (s) => s.source === 'ghost' && s.posted === 1 && ghostOverrideQualifies(s),
    );
    if (ghostOverrideAlreadyPosted) {
      console.log(`roundup: ${label} suppressed — ghost-override standalone already posted`);
      continue;
    }
    // Same rationale for thin-gap: a posted thin-gap is already the loudest
    // possible signal on a low-frequency route (the whole route went silent
    // for ≥60 min), and the few sub-threshold signals other detectors can
    // produce on thin routes shouldn't push a second roundup post out the
    // door covering the same incident.
    const thinGapAlreadyPosted = signals.some((s) => s.source === 'thin-gap' && s.posted === 1);
    if (thinGapAlreadyPosted) {
      console.log(`roundup: ${label} suppressed — thin-gap standalone already posted`);
      continue;
    }
    if (total < SCORE_THRESHOLD && !ghostOverride) {
      console.log(
        `roundup: ${label} score=${total.toFixed(2)} sources=${[...bySource.keys()].join(',')} below threshold`,
      );
      continue;
    }
    if (ghostOverride && total < SCORE_THRESHOLD) {
      console.log(
        `roundup: ${label} ghost-override admits (score=${total.toFixed(2)}, sources=${[...bySource.keys()].join(',')})`,
      );
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
      // Thread under an open CTA alert on the same route/line if one exists,
      // mirroring how pulse threads. Roundups carry no segment info so the
      // match is route-only — same conservative shape as bus pulse's
      // findOpenAlertReplyRefBus. Without this, a roundup fires top-level
      // even when an active CTA alert thread for the same route already
      // exists, fragmenting the conversation across two posts.
      const replyRef = await findOpenAlertReplyRefForRoundup(a, kind, id);
      const result = await postText(a, text, replyRef);
      console.log(
        `Posted roundup ${label}: ${result.url}${replyRef ? ' (threaded under open CTA alert)' : ''}`,
      );
      // Anchor the rollup so the related-quotes sweep can attach
      // subsequent on-route bunching/gap posts to this thread. Backdate
      // ts to the earliest contributing meta_signal — the cron's 5-min
      // cadence otherwise lands every roundup duration on a 5-min
      // boundary even when the underlying detectors saw the problem
      // minutes earlier.
      const earliestSignalTs = signals.reduce((m, s) => (s.ts < m ? s.ts : m), now);
      recordRoundupAnchor({
        kind,
        line: id,
        postUri: result.uri,
        postCid: result.cid,
        ts: earliestSignalTs,
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

// Look up the most recent unresolved CTA alert touching this route/line and
// return a reply ref pointing at it, or null. Route-match only — roundups
// have no segment info to score station overlap with.
async function findOpenAlertReplyRefForRoundup(agent, kind, line) {
  const code = kind === 'bus' ? line : LINE_TO_RAIL_ROUTE[line];
  if (!code) return null;
  const row = getDb()
    .prepare(`
      SELECT post_uri FROM alert_posts
      WHERE kind = ? AND resolved_ts IS NULL
        AND post_uri IS NOT NULL
        AND (',' || routes || ',') LIKE ?
      ORDER BY first_seen_ts DESC LIMIT 1
    `)
    .get(kind, `%,${code},%`);
  if (!row) return null;
  return resolveReplyRef(agent, row.post_uri);
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
      // Score still elevated → reset the consecutive-clear counter (the
      // helper also clears pending_resolved_ts so the next clean run picks
      // up its own first-tick stamp).
      if (row.clear_ticks !== 0) updateRoundupClearTicks(row.id, 0, now);
      continue;
    }
    const newClearTicks = (row.clear_ticks || 0) + 1;
    // Refine the pending-clear stamp: when score has dropped quiet, the
    // moment things actually went quiet is best approximated by the most
    // recent meta_signal that contributed in the window. If no signals
    // remain at all, fall back to now (cron tick).
    const latestSignalTs = signals.reduce((m, s) => (m == null || s.ts > m ? s.ts : m), null);
    const pendingClearTs = latestSignalTs ?? now;
    if (newClearTicks < RESOLVE_MIN_CLEAR_TICKS) {
      // First-tick stamping happens inside the helper via COALESCE on
      // pendingClearTs.
      updateRoundupClearTicks(row.id, newClearTicks, now, pendingClearTs);
      console.log(
        `roundup-resolve: ${label} clear tick ${newClearTicks}/${RESOLVE_MIN_CLEAR_TICKS} (score=${total.toFixed(2)})`,
      );
      continue;
    }
    const text = buildResolutionText({ kind, line: row.line, name: getName(row.line) });
    const link = resolvedEventLink(row.post_uri, text);
    if (DRY_RUN) {
      console.log(`--- DRY RUN roundup-resolve ${label} (link: ${link?.url}) ---\n${text}`);
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
      const result = link
        ? await postTextWithLinkCard(a, text, replyRef, link)
        : await postText(a, text, replyRef);
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
