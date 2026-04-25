const { haversineFt, terminalZoneFt: terminalZoneFor } = require('../shared/geo');
const { buildLinePolyline, snapToLine } = require('./speedmap');

const TRAIN_BUNCHING_FT = 2000; // ~0.38 mi
const MIN_DISTANCE_FT = 200;    // closer = same station / API glitch
const MAX_HEADING_DIFF_DEG = 60;

function headingDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Along-track snapping avoids false positives where trains are geographically
// close but far apart along the route (e.g. opposite sides of the Loop).
function detectAllTrainBunching(trains, trainLines) {
  const groups = new Map();
  for (const t of trains) {
    if (!t.trDr) continue;
    const key = `${t.line}_${t.trDr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

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

    const snapped = group
      .map((t) => ({ train: t, trackDist: snapToLine(t.lat, t.lon, points, cumDist) }))
      .sort((a, b) => a.trackDist - b.trackDist);

    // Dedupe near-coincident snaps — almost certainly the same train double-reported.
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

      if (lo < terminalZoneFt || totalFt - hi < terminalZoneFt) {
        i = j + 1;
        continue;
      }

      // Loop lines share one trDr in both directions, so parallel outbound/
      // inbound tracks can snap to similar trackDists. Heading gate keeps
      // opposite-direction trains from masquerading as bunches.
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

  bunches.sort((a, b) => {
    if (a.trains.length !== b.trains.length) return b.trains.length - a.trains.length;
    return a.maxGapFt - b.maxGapFt;
  });
  return bunches;
}

function detectTrainBunching(trains, trainLines) {
  const all = detectAllTrainBunching(trains, trainLines);
  return all.length ? all[0] : null;
}

module.exports = { detectTrainBunching, detectAllTrainBunching, TRAIN_BUNCHING_FT, MIN_DISTANCE_FT };
