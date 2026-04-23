const { haversineFt, terminalZoneFt: terminalZoneFor } = require('../shared/geo');
const { buildLinePolyline, snapToLine } = require('./speedmap');

const TRAIN_BUNCHING_FT = 2000; // ~0.38 mi, tighter than normal rush-hour headway
const MIN_DISTANCE_FT = 200;    // ignore pairs closer than this — likely same station or API glitch
const MAX_HEADING_DIFF_DEG = 60;   // pair must be moving geographically the same way

// Smallest angular difference between two compass headings (0–180).
function headingDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Detect all bunched clusters of trains on the same line heading the same
 * direction (same `trDr`), ranked best-first.
 *
 * Uses along-track distance by snapping each train onto the line's polyline.
 * This avoids false positives where trains are geographically close but far
 * apart along the route (e.g. opposite sides of the Loop).
 *
 * Clusters are extended as long as consecutive along-track gaps stay within
 * TRAIN_BUNCHING_FT, then ranked size-desc / tighter-max-gap first — same
 * model as bus bunching. The bin iterates the full list so a cooldown/cap
 * skip on one bunch falls through to the next candidate.
 */
function detectAllTrainBunching(trains, trainLines) {
  const groups = new Map();
  for (const t of trains) {
    if (!t.trDr) continue;
    const key = `${t.line}_${t.trDr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  // Cache polyline data per line so we don't rebuild it for every pair.
  const lineCache = new Map();
  function getLine(line) {
    if (!lineCache.has(line)) {
      lineCache.set(line, buildLinePolyline(trainLines, line));
    }
    return lineCache.get(line);
  }

  const bunches = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const [line, trDr] = key.split('_');
    const { points, cumDist } = getLine(line);
    if (points.length < 2) continue;
    const totalFt = cumDist[cumDist.length - 1];

    // Snap each train onto the polyline once, sort by along-track distance.
    const snapped = group
      .map((t) => ({ train: t, trackDist: snapToLine(t.lat, t.lon, points, cumDist) }))
      .sort((a, b) => a.trackDist - b.trackDist);

    // Dedupe near-coincident snaps: two rns reporting within MIN_DISTANCE_FT
    // along-track are almost certainly the same train (station stop, API
    // glitch) — keep the first and drop the rest so they don't masquerade as
    // a tight cluster.
    const deduped = [];
    for (const s of snapped) {
      if (deduped.length === 0 || s.trackDist - deduped[deduped.length - 1].trackDist >= MIN_DISTANCE_FT) {
        deduped.push(s);
      }
    }
    if (deduped.length < 2) continue;

    const terminalZoneFt = terminalZoneFor(totalFt);

    let i = 0;
    while (i < deduped.length - 1) {
      const gap0 = deduped[i + 1].trackDist - deduped[i].trackDist;
      if (gap0 > TRAIN_BUNCHING_FT) { i++; continue; }

      let j = i + 1;
      let maxGap = gap0;
      while (j + 1 < deduped.length) {
        const nextGap = deduped[j + 1].trackDist - deduped[j].trackDist;
        if (nextGap > TRAIN_BUNCHING_FT) break;
        if (nextGap > maxGap) maxGap = nextGap;
        j++;
      }

      const cluster = deduped.slice(i, j + 1);
      const lo = cluster[0].trackDist;
      const hi = cluster[cluster.length - 1].trackDist;

      // Skip terminal layovers: any train within the start/end zone means the
      // cluster is a terminal queue rather than real bunching mid-route.
      if (lo < terminalZoneFt || totalFt - hi < terminalZoneFt) {
        i = j + 1;
        continue;
      }

      // Heading gate: on loop lines (Orange/Brown/Pink/Purple) every train
      // shares trDr regardless of whether it's outbound or inbound, and the
      // line polyline is undirected — so trains on parallel outbound and
      // inbound tracks can snap to similar trackDists while moving in
      // opposite directions. Require every adjacent pair's compass heading
      // to agree.
      let headingOk = true;
      for (let k = 0; k + 1 < cluster.length; k++) {
        const ha = cluster[k].train.heading;
        const hb = cluster[k + 1].train.heading;
        if (Number.isFinite(ha) && Number.isFinite(hb) && headingDiff(ha, hb) > MAX_HEADING_DIFF_DEG) {
          headingOk = false;
          break;
        }
      }
      if (!headingOk) { i = j + 1; continue; }

      bunches.push({
        line,
        trDr,
        trains: cluster.map((c) => c.train),
        spanFt: hi - lo,
        maxGapFt: maxGap,
      });
      i = j + 1;
    }
  }

  // Rank: more trains first; tie-break on tighter max gap (same as buses).
  bunches.sort((a, b) => {
    if (a.trains.length !== b.trains.length) return b.trains.length - a.trains.length;
    return a.maxGapFt - b.maxGapFt;
  });
  return bunches;
}

// Back-compat wrapper — callers that just want the single best bunch.
function detectTrainBunching(trains, trainLines) {
  const all = detectAllTrainBunching(trains, trainLines);
  return all.length ? all[0] : null;
}

module.exports = { detectTrainBunching, detectAllTrainBunching, TRAIN_BUNCHING_FT, MIN_DISTANCE_FT };
