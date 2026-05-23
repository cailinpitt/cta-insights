const test = require('node:test');
const assert = require('node:assert');
const { clampTrackSeries, MAX_TRACK_STEP_FT } = require('../../src/train/bunchingVideo');

test('clampTrackSeries: forward-orientation series passes through unchanged', () => {
  const raw = [0, 500, 1100, 1700, 2300];
  assert.deepEqual(clampTrackSeries(raw), raw);
});

test('clampTrackSeries: north-to-south polyline (decreasing trackDist) is honored', () => {
  // Train moving its inferred forward direction, which is decreasing here.
  const raw = [10000, 9400, 8800, 8200, 7600];
  assert.deepEqual(clampTrackSeries(raw), raw);
});

test('clampTrackSeries: small backward jitter against forward direction is held', () => {
  // Forward = increasing. The 1100→1050 dip is a small GPS wiggle.
  const raw = [0, 500, 1100, 1050, 1600];
  assert.deepEqual(clampTrackSeries(raw), [0, 500, 1100, 1100, 1600]);
});

test('clampTrackSeries: rejects a single-tick teleport even in forward direction', () => {
  // The 904 post regression: forward = increasing, but a +5000 ft glitch
  // lands well past MAX_TRACK_STEP_FT and would otherwise lock the series.
  const big = MAX_TRACK_STEP_FT + 2000;
  const raw = [0, 500, 1000, 1000 + big, 1500, 2000];
  const clamped = clampTrackSeries(raw);
  assert.deepEqual(clamped, [0, 500, 1000, 1000, 1500, 2000]);
});

test('clampTrackSeries: rejects a teleport against forward direction', () => {
  // Forward = decreasing (south). A jump up by far more than MAX_TRACK_STEP_FT
  // is the same kind of GPS spike — must be rejected.
  const big = MAX_TRACK_STEP_FT + 1500;
  const raw = [10000, 9500, 9000, 9000 + big, 8500, 8000];
  assert.deepEqual(clampTrackSeries(raw), [10000, 9500, 9000, 9000, 8500, 8000]);
});

test('clampTrackSeries: forward direction inferred from net travel, not single ticks', () => {
  // Net forward is increasing despite a noisy first sample.
  const raw = [1000, 980, 1100, 1400, 1800, 2200];
  const clamped = clampTrackSeries(raw);
  // 1000 → 980 is small backward jitter against forward(+); held at 1000.
  assert.deepEqual(clamped, [1000, 1000, 1100, 1400, 1800, 2200]);
});

test('clampTrackSeries: empty input returns empty array', () => {
  assert.deepEqual(clampTrackSeries([]), []);
});

test('clampTrackSeries: regression — Red Line 902 GPS glitch parks train south', () => {
  // Modeled on the 04-30 08:04:50 incident: rn=902 reports a single-tick
  // jump ~3300 ft against its actual northbound motion, then recovers.
  // Old non-decreasing clamp on increasing-track polyline would have locked
  // it at the glitch. The new clamp must hold prev across the glitch.
  const raw = [
    100_000, // initial
    100_500, // moving forward
    101_000,
    101_500,
    104_900, // glitch: +3400 ft against forward
    102_000, // recovery
    102_500,
    103_000,
  ];
  const clamped = clampTrackSeries(raw);
  assert.deepEqual(
    clamped,
    [100_000, 100_500, 101_000, 101_500, 101_500, 102_000, 102_500, 103_000],
  );
});

const { attachTrails } = require('../../src/train/bunchingVideo');

test('attachTrails: builds rn-keyed trail and skips parked turnarounds', () => {
  const frames = [
    [{ rn: '406', lat: 0, lon: 0 }],
    [{ rn: '406', lat: 0, lon: 1 }],
    [{ rn: '406', lat: 0, lon: 2, turnaround: true }],
  ];
  attachTrails(frames, 5);
  assert.deepEqual(
    frames[1][0].trail.map((p) => p.lon),
    [0, 1],
  );
  assert.equal(frames[2][0].trail, undefined, 'parked train gets no trail');
  assert.equal(frames[0][0].trail, undefined, 'first frame has no prior position');
});
