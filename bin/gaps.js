#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getVehicles, getPredictions } = require('../src/cta');
const { names: routeNames, gaps: gapRoutes } = require('../src/routes');
const { detectAllGaps } = require('../src/gaps');
const { loadPattern } = require('../src/patterns');
const { renderGapMap } = require('../src/map');
const { loginBus, postWithImage } = require('../src/bluesky');
const { isOnCooldown, acquireCooldown } = require('../src/state');
const { pruneOldAssets } = require('../src/cleanup');
const { expectedHeadwayMin } = require('../src/gtfs');
const history = require('../src/history');

function findNearestStop(pattern, pdist) {
  const stops = pattern.points.filter((p) => p.type === 'S' && p.stopName);
  let best = stops[0];
  let bestDelta = Math.abs(stops[0].pdist - pdist);
  for (const s of stops) {
    const delta = Math.abs(s.pdist - pdist);
    if (delta < bestDelta) { best = s; bestDelta = delta; }
  }
  return best;
}

function formatDistance(ft) {
  if (ft < 1000) return `${ft} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function fmtMin(m) {
  const rounded = Math.round(m);
  return `${rounded} min`;
}

function buildPostText(gap, pattern, stop, callouts = []) {
  const routeName = routeNames[gap.route];
  const title = routeName ? `Route ${gap.route} (${routeName})` : `Route ${gap.route}`;
  const base = `🕳️ ${title} — ${pattern.direction}\n${fmtMin(gap.gapMin)} gap near ${stop.stopName} — scheduled every ${fmtMin(gap.expectedMin)}`;
  const tail = history.formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
}

function buildAltText(gap, pattern, stop) {
  const routeName = routeNames[gap.route];
  const title = routeName ? `Route ${gap.route} (${routeName})` : `Route ${gap.route}`;
  return `Map of ${title} ${pattern.direction.toLowerCase()} showing a ${fmtMin(gap.gapMin)} gap between buses near ${stop.stopName}.`;
}

async function main() {
  pruneOldAssets();
  history.rolloffOld();

  const routes = gapRoutes;
  console.log(`Fetching vehicles for ${routes.length} routes...`);
  const vehicles = await getVehicles(routes);
  console.log(`Got ${vehicles.length} vehicles`);

  // Resolve pattern + expected headway per unique pid once, lazily. We can't
  // pre-fetch because we don't know which pids have candidate gaps until the
  // detector runs, and the detector needs pattern+headway to filter. Solution:
  // pass memoized fetchers into the detector.
  const patternCache = new Map();
  const headwayCache = new Map();
  async function primePid(pid) {
    if (!patternCache.has(pid)) patternCache.set(pid, await loadPattern(pid));
    const pattern = patternCache.get(pid);
    if (!headwayCache.has(pid)) {
      // Pattern object doesn't embed route — pull it from any vehicle on this pid.
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
  );

  if (gaps.length === 0) {
    console.log('No significant gaps detected');
    return;
  }

  console.log(`Found ${gaps.length} candidate gap(s); picking best available:`);
  for (const g of gaps) {
    console.log(`  route ${g.route} pid ${g.pid} — gap ${Math.round(g.gapMin)} min vs ${g.expectedMin} expected (ratio ${g.ratio.toFixed(2)})`);
  }

  let gap = null;
  let pattern = null;
  let chosenStop = null;
  for (const candidate of gaps) {
    const candidatePattern = patternCache.get(candidate.pid);
    const midPdist = (candidate.leading.pdist + candidate.trailing.pdist) / 2;
    const stop = findNearestStop(candidatePattern, midPdist);

    // Skip if stop resolution landed on a terminal — same reasoning as bunching.
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
      if (pidCd || routeCd) {
        console.log(`  skip pid ${candidate.pid}: ${pidCd ? 'pid' : 'route'} on cooldown`);
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

  // Refine gapMin with CTA BusTime predictions. Rider framing: standing at a
  // stop just past the leading bus, how long until the trailing bus arrives?
  //
  // BusTime only predicts ~30 min out, so big gaps (the ones we care about
  // most) never return a direct prediction at the leading bus's stop. Instead
  // we pull all predictions for the trailing bus, find its *farthest* predicted
  // stop that's still on this pattern, and add the remaining distance from
  // there to the leading bus at a typical 10 mph. This anchors the estimate on
  // BusTime's real-time ETA and uses the crude constant only for the tail.
  try {
    const leadingStop = findNearestStop(pattern, gap.leading.pdist);
    const preds = await getPredictions({ vid: gap.trailing.vid });
    // Map stpid → pattern stop with a pdist so we can measure distance.
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
      .map((p) => ({ pred: p, stop: stopsByStpid.get(String(p.stpid)), min: predMinutes(p.prdctdn) }))
      .filter((x) => x.stop && x.min != null && x.stop.pdist < gap.leading.pdist);

    if (onPattern.length > 0) {
      // Pick the stop with the largest pdist (closest to leading bus) so the
      // extrapolation tail is as short as possible.
      const anchor = onPattern.reduce((best, x) => (x.stop.pdist > best.stop.pdist ? x : best));
      const remainingFt = gap.leading.pdist - anchor.stop.pdist;
      const tailMin = remainingFt / 880; // 10 mph ≈ 880 ft/min
      const refined = anchor.min + tailMin;
      console.log(`Prediction refinement: ${gap.gapMin.toFixed(1)} min (distance) → ${refined.toFixed(1)} min (anchor: ${anchor.min} min at ${anchor.stop.stopName} + ${tailMin.toFixed(1)} min to ${leadingStop.stopName})`);
      gap.gapMin = refined;
      gap.ratio = refined / gap.expectedMin;
    } else {
      console.log(`No usable predictions for vid ${gap.trailing.vid} on this pattern; keeping distance estimate`);
    }
  } catch (e) {
    console.warn(`Prediction refinement failed: ${e.message}; keeping distance estimate`);
  }

  // Re-check thresholds in case the refined ETA moved us below the bar.
  const { RATIO_THRESHOLD, ABSOLUTE_MIN_MIN } = require('../src/gaps');
  if (gap.gapMin < ABSOLUTE_MIN_MIN || gap.ratio < RATIO_THRESHOLD) {
    console.log(`After refinement, gap no longer meets threshold (${gap.gapMin} min, ${gap.ratio.toFixed(2)}x); skipping`);
    return;
  }

  console.log(`Posting: route ${gap.route} pid ${gap.pid} — ${Math.round(gap.gapMin)} min gap (${gap.ratio.toFixed(2)}x expected)`);

  const callouts = history.gapCallouts({
    kind: 'bus',
    route: gap.route,
    routeLabel: `Route ${gap.route}`,
    ratio: gap.ratio,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  console.log('Rendering map...');
  const image = await renderGapMap(gap, pattern);

  const text = buildPostText(gap, pattern, chosenStop, callouts);
  const alt = buildAltText(gap, pattern, chosenStop);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `gap-${gap.route}-${pattern.direction.toLowerCase()}-${gap.pid}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  if (!acquireCooldown([`gap:${gap.pid}`, `gap:route:${gap.route}`])) {
    console.log('Lost cooldown race to another instance, skipping post');
    history.recordGap({
      kind: 'bus',
      route: gap.route,
      direction: gap.pid,
      gapFt: gap.gapFt,
      gapMin: gap.gapMin,
      expectedMin: gap.expectedMin,
      ratio: gap.ratio,
      nearStop: chosenStop.stopName,
      posted: false,
    });
    return;
  }

  const agent = await loginBus();
  const primary = await postWithImage(agent, text, image, alt);
  history.recordGap({
    kind: 'bus',
    route: gap.route,
    direction: gap.pid,
    gapFt: gap.gapFt,
    gapMin: gap.gapMin,
    expectedMin: gap.expectedMin,
    ratio: gap.ratio,
    nearStop: chosenStop.stopName,
    posted: true,
    postUri: primary.uri,
  });
  console.log(`Posted: ${primary.url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
