const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const trainLines = require('../../src/train/data/trainLines.json');
const { buildLineBranches, computeTrainSamples, inLoopTrunk } = require('../../src/train/speedmap');
const { binSegments } = require('../../src/bus/speedmap');

// Captured AVL pings from a 10-min collectTrains run on cailin-server,
// one fixture per Loop trunk line. See bugs.md for context — the renderer
// paints the elevated Loop trunk almost entirely green even though the
// recorded run stats show only ~10% of all bins compute as green. These
// fixtures replay that scenario deterministically.
const LINES = ['brn', 'org', 'pink', 'p'];
const FT_PER_BIN = 2640; // 0.5 mi, matches bin/train/speedmap.js
const MIN_BINS = 8;

function loadFixture(line) {
  const file = path.join(__dirname, '..', 'fixtures', `${line}-tracks.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tracks = new Map();
  for (const [rn, byDir] of Object.entries(raw.tracks)) {
    const m = new Map();
    for (const [trDr, positions] of Object.entries(byDir)) m.set(trDr, positions);
    tracks.set(rn, m);
  }
  return tracks;
}

// Mirrors the per-branch loop in bin/train/speedmap.js: compute samples,
// apply each branch's trDrFilter, bin into per-direction speed arrays.
function processBranches(line) {
  const tracks = loadFixture(line);
  const branches = buildLineBranches(trainLines, line);
  return branches.map((branch) => {
    const { points, cumDist, totalFt } = branch;
    const { byDir } = computeTrainSamples(tracks, points, cumDist);
    const numBins = Math.max(MIN_BINS, Math.round(totalFt / FT_PER_BIN));
    const binSpeedsByDir = {};
    const trDrFilter = branch.trDrFilter || null;
    for (const [trDr, samples] of byDir) {
      if (trDrFilter && trDr !== trDrFilter) continue;
      binSpeedsByDir[trDr] = binSegments(samples, totalFt, numBins);
    }
    return { branch, binSpeedsByDir, numBins };
  });
}

function loopBinIndices(branch, numBins) {
  const { points, cumDist, totalFt } = branch;
  const binWidth = totalFt / numBins;
  const set = new Set();
  for (let i = 0; i < points.length; i++) {
    const [lat, lon] = points[i];
    if (inLoopTrunk(lat, lon)) {
      const bin = Math.min(numBins - 1, Math.floor(cumDist[i] / binWidth));
      set.add(bin);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function bucketLabel(mph) {
  if (mph == null) return 'gray';
  if (mph < 15) return 'red';
  if (mph < 25) return 'orange';
  if (mph < 35) return 'yellow';
  if (mph < 45) return 'purple';
  return 'green';
}

// Mirrors src/map/bus/speedmap.js speedForTrainRender: bins 0 and N-1
// fall back to the nearest interior non-null bin.
function speedForRender(binSpeeds, idx) {
  if (binSpeeds[idx] != null) return binSpeeds[idx];
  const last = binSpeeds.length - 1;
  if (idx === 0) {
    for (let i = 1; i <= last; i++) if (binSpeeds[i] != null) return binSpeeds[i];
  } else if (idx === last) {
    for (let i = last - 1; i >= 0; i--) if (binSpeeds[i] != null) return binSpeeds[i];
  }
  return null;
}

// Final visible color per bin: render each branch's ribbon in order, then
// each branch's directions, applying speedForRender. A later paint with a
// non-null color OR a null-that-falls-back-to-non-null replaces earlier paints.
function renderedBins(branchData) {
  const numBins = branchData[0].numBins;
  const out = new Array(numBins).fill(null);
  for (const { binSpeedsByDir } of branchData) {
    for (const speeds of Object.values(binSpeedsByDir)) {
      for (let i = 0; i < numBins; i++) {
        const v = speedForRender(speeds, i);
        if (v != null) out[i] = v;
      }
    }
  }
  return out;
}

// Direct regression for the green-Loop snapping artifact. The Pink inbound
// polyline's Loop north side (Lake St) is colinear with the Lake St approach,
// so the same physical spot maps to two far-apart cumDist values. A train
// rounding the Loop across that zone with a brief feed gap snaps to an
// along-track jump of thousands of feet — a phantom 57 mph that paints the
// inbound Loop bins green. The crow-flight guard in computeTrainSamples must
// reject it. The captured fixtures above are clean runs that pass with or
// without the guard; this test pins the actual defect.
test('pink: colinear Loop-trunk snap jump is rejected, not binned green', () => {
  const inbound = buildLineBranches(trainLines, 'pink').find((b) => b.directionHint === 'inbound');
  const { points, cumDist } = inbound;
  // Two pings ~830 ft apart physically, 90 s apart, that snap across the
  // colinear approach/Loop overlap (along-track ≈ 7,000 ft → 57 mph).
  const tracks = new Map([
    [
      '999',
      new Map([
        [
          '1',
          [
            { t: 0, lat: 41.8857, lon: -87.628 },
            { t: 90_000, lat: 41.882, lon: -87.6339 },
          ],
        ],
      ]),
    ],
  ]);

  // Without the guard the pair becomes a green (≥45 mph) sample in the Loop bins.
  const unguarded = computeTrainSamples(tracks, points, cumDist, { maxAlongCrowRatio: Infinity });
  const phantom = unguarded.byDir.get('1') || [];
  assert.equal(phantom.length, 1);
  assert.ok(phantom[0].mph >= 45, `expected a green phantom sample, got ${phantom[0].mph} mph`);

  // With the guard (default) it is dropped as a snap jump, leaving no sample.
  const guarded = computeTrainSamples(tracks, points, cumDist);
  assert.equal((guarded.byDir.get('1') || []).length, 0);
  assert.equal(guarded.stats.snapJump, 1);
});

for (const line of LINES) {
  test(`${line}: rendered Loop trunk bins are not majority green`, () => {
    const branchData = processBranches(line);
    const numBins = branchData[0].numBins;
    const loopBins = loopBinIndices(branchData[0].branch, numBins);

    // Per-branch raw speeds for diagnostics.
    for (const { branch, binSpeedsByDir } of branchData) {
      for (const [trDr, speeds] of Object.entries(binSpeedsByDir)) {
        const report = loopBins.map((i) => {
          const v = speeds[i];
          return `b${i}=${v == null ? '·' : v.toFixed(0)}`;
        });
        console.log(
          `[${line}] branch trDr=${trDr} dir=${branch.directionHint || '?'} loop: ${report.join(' ')}`,
        );
      }
    }

    const rendered = renderedBins(branchData);
    const renderReport = loopBins.map((i) => {
      const v = rendered[i];
      return `bin${i}=${v == null ? 'null' : v.toFixed(1)}(${bucketLabel(v)})`;
    });
    console.log(`[${line}] RENDERED loop bins: ${renderReport.join(' ')}`);

    const visible = loopBins.map((i) => rendered[i]).filter((s) => s != null);
    const green = visible.filter((s) => s >= 45).length;
    assert.ok(
      green / Math.max(1, visible.length) < 0.5,
      `${line}: ${green}/${visible.length} rendered loop bins are green — should be mostly orange/yellow`,
    );
  });
}
