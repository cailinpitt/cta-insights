const test = require('node:test');
const assert = require('node:assert/strict');
const {
  snapToLine, pointAlongLine, buildLineBranches, buildLinePolyline,
  computeTrainSamples, pickTargetDir,
} = require('../src/train/speedmap');
const { straightLine, pointAtFt } = require('./helpers');

const LINE_FT = 50000;
const line = straightLine(LINE_FT);

test('snapToLine projects an on-line point back to its trackDist', () => {
  const points = line.map((p) => ({ lat: p[0], lon: p[1] }));
  const cumDist = [0];
  const { haversineFt } = require('../src/shared/geo');
  for (let i = 1; i < points.length; i++) cumDist.push(cumDist[i - 1] + haversineFt(points[i - 1], points[i]));

  const mid = pointAtFt(LINE_FT, 20000);
  const d = snapToLine(mid.lat, mid.lon, line, cumDist);
  assert.ok(Math.abs(d - 20000) < 100);
});

test('pointAlongLine is the inverse of snapToLine within tolerance', () => {
  const points = line.map((p) => ({ lat: p[0], lon: p[1] }));
  const cumDist = [0];
  const { haversineFt } = require('../src/shared/geo');
  for (let i = 1; i < points.length; i++) cumDist.push(cumDist[i - 1] + haversineFt(points[i - 1], points[i]));

  const pt = pointAlongLine(line, cumDist, 25000);
  const expected = pointAtFt(LINE_FT, 25000);
  assert.ok(Math.abs(pt.lat - expected.lat) < 1e-4);
  assert.ok(Math.abs(pt.lon - expected.lon) < 1e-4);
});

test('round-trip polylines are truncated at the apex when built into branches', () => {
  // Out-and-back segment: north then returns south to start.
  const outAndBack = [];
  for (let i = 0; i <= 4; i++) outAndBack.push([41.9 + i * 0.01, -87.65]);
  for (let i = 3; i >= 0; i--) outAndBack.push([41.9 + i * 0.01, -87.65]);
  const trainLines = { org: [outAndBack] };
  const [branch] = buildLineBranches(trainLines, 'org');
  // Return leg should be dropped — keep only the outbound half (5 vertices).
  assert.equal(branch.points.length, 5);
  assert.ok(branch.totalFt > 0);
});

test('buildLineBranches exposes all branches; buildLinePolyline returns the longest', () => {
  const trainLines = {
    g: [straightLine(50000), straightLine(30000)],
  };
  const branches = buildLineBranches(trainLines, 'g');
  assert.equal(branches.length, 2);
  const longest = buildLinePolyline(trainLines, 'g');
  assert.equal(longest.points.length, branches[0].points.length);
});

test('computeTrainSamples pairs consecutive positions into mph samples', () => {
  const points = line.map((p) => ({ lat: p[0], lon: p[1] }));
  const cumDist = [0];
  const { haversineFt } = require('../src/shared/geo');
  for (let i = 1; i < points.length; i++) cumDist.push(cumDist[i - 1] + haversineFt(points[i - 1], points[i]));

  // One train ('1') heading along the line over 60s, advancing 2200 ft.
  // 2200 ft/min → 25 mph.
  const p1 = pointAtFt(LINE_FT, 10000);
  const p2 = pointAtFt(LINE_FT, 12200);
  const tracks = new Map([
    ['R1', new Map([['5', [
      { t: 0, lat: p1.lat, lon: p1.lon },
      { t: 60_000, lat: p2.lat, lon: p2.lon },
    ]]])],
  ]);
  const { byDir } = computeTrainSamples(tracks, line, cumDist);
  const samples = byDir.get('5');
  assert.equal(samples.length, 1);
  assert.ok(Math.abs(samples[0].mph - 25) < 1);
});

test('computeTrainSamples drops off-line samples via maxPerpFt', () => {
  const points = line.map((p) => ({ lat: p[0], lon: p[1] }));
  const cumDist = [0];
  const { haversineFt } = require('../src/shared/geo');
  for (let i = 1; i < points.length; i++) cumDist.push(cumDist[i - 1] + haversineFt(points[i - 1], points[i]));

  const p1 = pointAtFt(LINE_FT, 10000);
  // Shift p2 ~0.05 deg east (≈ 14000 ft) so perpDist > maxPerpFt of 1000.
  const p2 = pointAtFt(LINE_FT, 12200);
  const tracks = new Map([
    ['R1', new Map([['5', [
      { t: 0, lat: p1.lat, lon: p1.lon },
      { t: 60_000, lat: p2.lat, lon: p2.lon + 0.05 },
    ]]])],
  ]);
  const { byDir, stats } = computeTrainSamples(tracks, line, cumDist);
  assert.equal(byDir.size, 0);
  assert.equal(stats.offLine, 1);
});

test('pickTargetDir picks the direction with the most samples', () => {
  const byDir = new Map([
    ['1', [{}, {}]],
    ['5', [{}, {}, {}]],
  ]);
  assert.equal(pickTargetDir(byDir), '5');
  assert.equal(pickTargetDir(new Map()), undefined);
});
