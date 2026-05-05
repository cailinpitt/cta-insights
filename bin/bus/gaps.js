#!/usr/bin/env node
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getVehiclesCachedOrFresh, getPredictions } = require('../../src/bus/api');
const { gaps: gapRoutes } = require('../../src/bus/routes');
const { detectAllGaps } = require('../../src/bus/gaps');
const { loadPattern, findNearestStop } = require('../../src/bus/patterns');
const { renderGapMap } = require('../../src/map');
const { loginBus, postWithImage, postText } = require('../../src/bus/bluesky');
const { isOnCooldown } = require('../../src/shared/state');
const { commitAndPost } = require('../../src/shared/postDetection');
const { expectedHeadwayMin, loadIndex } = require('../../src/shared/gtfs');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { buildPostText, buildAltText } = require('../../src/bus/gapPost');

const BUS_GAP_DAILY_CAP = 3;

async function main() {
  setup();

  const routes = gapRoutes;
  const index = loadIndex();
  const unindexed = routes.filter((r) => !index.routes[r]);
  if (unindexed.length) {
    console.warn(
      `Routes missing from GTFS index (will be skipped): ${unindexed.join(', ')} — re-run scripts/fetch-gtfs.js`,
    );
  }

  const { vehicles, now, source } = await getVehiclesCachedOrFresh(routes);
  console.log(
    `Got ${vehicles.length} vehicles (${source}, snapshot ${new Date(now).toISOString()})`,
  );

  // Memoized fetchers passed into the detector — pattern.route isn't on the
  // pattern object so we sample any vehicle to get it.
  const patternCache = new Map();
  const headwayCache = new Map();
  async function primePid(pid) {
    if (!patternCache.has(pid)) patternCache.set(pid, await loadPattern(pid));
    const pattern = patternCache.get(pid);
    if (!headwayCache.has(pid)) {
      const sample = vehicles.find((v) => v.pid === pid);
      const exp = sample ? expectedHeadwayMin(sample.route, pattern) : null;
      headwayCache.set(pid, exp);
    }
  }

  const uniquePids = [...new Set(vehicles.map((v) => v.pid))];
  for (const pid of uniquePids) await primePid(pid);

  const gaps = detectAllGaps(
    vehicles,
    (pid) => headwayCache.get(pid) ?? null,
    (pid) => patternCache.get(pid) || null,
    now,
  );

  if (gaps.length === 0) {
    console.log('No significant gaps detected');
    return;
  }

  console.log(`Found ${gaps.length} candidate gap(s); picking best available:`);
  for (const g of gaps) {
    console.log(
      `  route ${g.route} pid ${g.pid} — gap ${Math.round(g.gapMin)} min vs ${g.expectedMin} expected (ratio ${g.ratio.toFixed(2)})`,
    );
  }

  let gap = null;
  let pattern = null;
  let chosenStop = null;
  // Set when the chosen candidate broke through an active cooldown via the
  // severity-margin gate (see commitAndPost for why this matters).
  let cooldownOverridden = false;
  for (const candidate of gaps) {
    const candidatePattern = patternCache.get(candidate.pid);
    // Anchor at the leading bus: the gap minutes describe a rider who just
    // watched it pass. The geographic midpoint misleads — a rider there only
    // waits half the posted gap.
    const stop = findNearestStop(candidatePattern, candidate.leading.pdist);

    const stops = candidatePattern.points.filter((p) => p.type === 'S' && p.stopName);
    if (stop === stops[0] || stop === stops[stops.length - 1]) {
      console.log(`  skip pid ${candidate.pid}: nearest stop "${stop.stopName}" is a terminal`);
      continue;
    }

    const pidKey = `gap:${candidate.pid}`;
    const routeKey = `gap:route:${candidate.route}`;
    if (!argv['dry-run']) {
      const pidCd = isOnCooldown(pidKey);
      const routeCd = isOnCooldown(routeKey);
      // Both pid and route cooldown allow a strictly-more-severe-by-margin
      // escalation through, mirroring the bunching path. Ratio-based gate
      // with a 1.25× margin so a 3.1× doesn't bypass a 3.0× post on the
      // same incident.
      const cooldownAllows = history.gapCooldownAllows({
        kind: 'bus',
        route: candidate.route,
        candidate: { ratio: candidate.ratio },
      });
      const pidCdOverride = pidCd && cooldownAllows;
      const routeCdOverride = routeCd && cooldownAllows;
      if ((pidCd && !pidCdOverride) || (routeCd && !routeCdOverride)) {
        const which = pidCd && !pidCdOverride ? 'pid' : 'route';
        console.log(`  skip pid ${candidate.pid}: ${which} on cooldown`);
        history.recordGap({
          kind: 'bus',
          route: candidate.route,
          direction: candidate.pid,
          gapFt: candidate.gapFt,
          gapMin: candidate.gapMin,
          expectedMin: candidate.expectedMin,
          ratio: candidate.ratio,
          nearStop: stop.stopName,
          posted: false,
        });
        history.recordMetaSignal({
          kind: 'bus',
          line: candidate.route,
          direction: candidate.pid,
          source: 'gap',
          severity: Math.min(1, candidate.ratio / 4),
          detail: { ratio: candidate.ratio, suppressed: 'cooldown' },
          posted: false,
        });
        continue;
      }
      if (pidCdOverride || routeCdOverride) {
        const which = pidCdOverride ? 'pid' : 'route';
        console.log(
          `  override ${which} cooldown for pid ${candidate.pid}: ${candidate.ratio.toFixed(2)}× clears decaying-margin or sustained-severity gate`,
        );
        cooldownOverridden = true;
      }
      const capAllows = history.gapCapAllows({
        kind: 'bus',
        route: candidate.route,
        candidate: { ratio: candidate.ratio },
        cap: BUS_GAP_DAILY_CAP,
      });
      if (!capAllows) {
        console.log(
          `  skip pid ${candidate.pid}: route ${candidate.route} at daily cap (${BUS_GAP_DAILY_CAP}) and not more severe than today's posts`,
        );
        history.recordGap({
          kind: 'bus',
          route: candidate.route,
          direction: candidate.pid,
          gapFt: candidate.gapFt,
          gapMin: candidate.gapMin,
          expectedMin: candidate.expectedMin,
          ratio: candidate.ratio,
          nearStop: stop.stopName,
          posted: false,
        });
        history.recordMetaSignal({
          kind: 'bus',
          line: candidate.route,
          direction: candidate.pid,
          source: 'gap',
          severity: Math.min(1, candidate.ratio / 4),
          detail: { ratio: candidate.ratio, suppressed: 'cap' },
          posted: false,
        });
        continue;
      }
    }
    gap = candidate;
    pattern = candidatePattern;
    chosenStop = stop;
    break;
  }

  if (!gap) {
    console.log('All candidates filtered (cooldown or terminal), nothing to post');
    return;
  }

  // BusTime caps predictions at ~30 min, so the big gaps (the ones we care
  // about) never have a direct prediction at the leading bus's stop. Anchor
  // on the trailing bus's farthest on-pattern predicted stop and extrapolate
  // the remaining distance at 10 mph.
  try {
    const leadingStop = findNearestStop(pattern, gap.leading.pdist);
    const preds = await getPredictions({ vid: gap.trailing.vid });
    const stopsByStpid = new Map();
    for (const pt of pattern.points) {
      if (pt.type === 'S' && pt.stopId) stopsByStpid.set(String(pt.stopId), pt);
    }
    function predMinutes(raw) {
      if (raw === 'DUE') return 1;
      if (/^\d+$/.test(String(raw))) return parseInt(raw, 10);
      return null;
    }
    const onPattern = preds
      .map((p) => ({
        pred: p,
        stop: stopsByStpid.get(String(p.stpid)),
        min: predMinutes(p.prdctdn),
      }))
      .filter((x) => x.stop && x.min != null && x.stop.pdist < gap.leading.pdist);

    if (onPattern.length > 0) {
      // Pick the closest-to-leading stop so the extrapolation tail is shortest.
      const anchor = onPattern.reduce((best, x) => (x.stop.pdist > best.stop.pdist ? x : best));
      const remainingFt = gap.leading.pdist - anchor.stop.pdist;
      const tailMin = remainingFt / 880; // 10 mph ≈ 880 ft/min
      const refined = anchor.min + tailMin;
      console.log(
        `Prediction refinement: ${gap.gapMin.toFixed(1)} min (distance) → ${refined.toFixed(1)} min (anchor: ${anchor.min} min at ${anchor.stop.stopName} + ${tailMin.toFixed(1)} min to ${leadingStop.stopName})`,
      );
      gap.gapMin = refined;
      gap.ratio = refined / gap.expectedMin;
    } else {
      console.log(
        `No usable predictions for vid ${gap.trailing.vid} on this pattern; keeping distance estimate`,
      );
    }
  } catch (e) {
    console.warn(`Prediction refinement failed: ${e.message}; keeping distance estimate`);
  }

  // Re-check thresholds: refinement may have moved us below the bar.
  const { RATIO_THRESHOLD, ABSOLUTE_MIN_MIN } = require('../../src/bus/gaps');
  if (gap.gapMin < ABSOLUTE_MIN_MIN || gap.ratio < RATIO_THRESHOLD) {
    console.log(
      `After refinement, gap no longer meets threshold (${gap.gapMin} min, ${gap.ratio.toFixed(2)}x); skipping`,
    );
    return;
  }

  console.log(
    `Posting: route ${gap.route} pid ${gap.pid} — ${Math.round(gap.gapMin)} min gap (${gap.ratio.toFixed(2)}x expected)`,
  );

  const callouts = history.gapCallouts({
    kind: 'bus',
    route: gap.route,
    routeLabel: `Route ${gap.route}`,
    ratio: gap.ratio,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  console.log('Rendering map...');
  let image;
  try {
    image = await renderGapMap(gap, pattern);
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  const text = buildPostText(gap, pattern, chosenStop, callouts);
  const alt = buildAltText(gap, pattern, chosenStop);

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(
      image,
      `gap-${gap.route}-${pattern.direction.toLowerCase()}-${gap.pid}-${Date.now()}.jpg`,
    );
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const baseEvent = {
    kind: 'bus',
    route: gap.route,
    direction: gap.pid,
    gapFt: gap.gapFt,
    gapMin: gap.gapMin,
    expectedMin: gap.expectedMin,
    ratio: gap.ratio,
    nearStop: chosenStop.stopName,
  };
  await commitAndPost({
    cooldownKeys: [`gap:${gap.pid}`, `gap:route:${gap.route}`],
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => history.recordGap({ ...baseEvent, posted: false }),
    agentLogin: loginBus,
    image,
    text,
    alt,
    recordPosted: (primary) =>
      history.recordGap({ ...baseEvent, posted: true, postUri: primary.uri }),
    postWithImage,
    postText,
  });
}

runBin(main);
