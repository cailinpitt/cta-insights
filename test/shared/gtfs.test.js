const test = require('node:test');
const assert = require('node:assert/strict');
const { hourlyLookup, expectedHeadwayMin } = require('../../src/shared/gtfs');

// Fixed reference moments, all chosen so Chicago wall-clock is unambiguous
// (mid-April 2026 is firmly in CDT, UTC-5).
const SUN_1AM = new Date('2026-04-19T06:00:00Z');   // prior = saturday
const MON_1AM = new Date('2026-04-20T06:00:00Z');   // prior = sunday
const SAT_1AM = new Date('2026-04-18T06:00:00Z');   // prior = weekday (Fri)
const TUE_2PM = new Date('2026-04-21T19:00:00Z');   // weekday daytime
const SAT_2PM = new Date('2026-04-18T19:00:00Z');   // saturday daytime
const TUE_5AM = new Date('2026-04-21T10:00:00Z');   // just past late-night cutoff
const SAT_5AM = new Date('2026-04-18T10:00:00Z');   // post-cutoff, prior (Fri weekday) != today (saturday)

test('hourlyLookup: daytime uses today, not prior', () => {
  assert.equal(hourlyLookup({ weekday: { 14: 9 }, sunday: { 14: 99 } }, TUE_2PM), 9);
});

test('hourlyLookup: late-night prefers prior day', () => {
  // 1 AM Sunday wall-clock: CTA indexes "25:00" Saturday trips under
  // {saturday, hour 1}. Saturday should win over Sunday.
  assert.equal(
    hourlyLookup({ saturday: { 1: 22 }, sunday: { 1: 99 } }, SUN_1AM),
    22,
  );
});

test('hourlyLookup: late-night falls back to today if prior missing', () => {
  assert.equal(hourlyLookup({ sunday: { 1: 22 } }, SUN_1AM), 22);
});

test('hourlyLookup: late-night Monday uses sunday (prior), not weekday (today)', () => {
  assert.equal(
    hourlyLookup({ sunday: { 1: 22 }, weekday: { 1: 99 } }, MON_1AM),
    22,
  );
});

test('hourlyLookup: late-night Saturday uses weekday (prior Friday) first', () => {
  assert.equal(
    hourlyLookup({ weekday: { 1: 22 }, saturday: { 1: 99 } }, SAT_1AM),
    22,
  );
});

test('hourlyLookup: post-cutoff uses today, with prior as fallback', () => {
  // 5 AM Saturday: today (saturday) preferred.
  assert.equal(hourlyLookup({ saturday: { 5: 7 }, weekday: { 5: 99 } }, SAT_5AM), 7);
  // Today missing → prior (weekday Friday) still tried since it may still be mid-route.
  assert.equal(hourlyLookup({ weekday: { 5: 22 } }, SAT_5AM), 22);
});

test('hourlyLookup: regression — no nearest-hour interpolation', () => {
  // The Route 82 scenario that originally caused bogus ghost posts: weekday
  // schedule peaks at hour 21=9min, but route doesn't run at 1 AM. Prior
  // (weekday Friday) hour 1 missing too. Must return null, not 9.
  assert.equal(
    hourlyLookup({ weekday: { 21: 9 }, saturday: { 21: 9 } }, SUN_1AM),
    null,
  );
});

test('hourlyLookup: weekend aggregate used when sat/sun bucket missing', () => {
  assert.equal(hourlyLookup({ weekend: { 14: 10 } }, SAT_2PM), 10);
});

test('hourlyLookup: weekend aggregate not consulted on weekdays', () => {
  assert.equal(hourlyLookup({ weekend: { 14: 10 } }, TUE_2PM), null);
});

test('hourlyLookup: null byDayType returns null', () => {
  assert.equal(hourlyLookup(null, TUE_2PM), null);
  assert.equal(hourlyLookup(undefined, TUE_2PM), null);
});

// End-to-end smoke tests against the committed index.json — these couple to
// real data but validate that the indexer + lookup work together for the
// scenarios that prompted the fix.
test('expectedHeadwayMin: Route 82 at 1 AM Sunday returns null (not a 24h route)', () => {
  const { loadIndex } = require('../../src/shared/gtfs');
  const info = loadIndex().routes['82'];
  if (!info) return; // index not built locally; skip rather than fail
  const dir0 = info['0'];
  const pattern = { pid: 'test82-0', points: [{ lat: 0, lon: 0 }, { lat: dir0.terminalLat, lon: dir0.terminalLon }] };
  assert.equal(expectedHeadwayMin('82', pattern, SUN_1AM), null);
});

test('expectedHeadwayMin: Route 22 at 1 AM Sunday returns data (24h route, via prior-day)', () => {
  const { loadIndex } = require('../../src/shared/gtfs');
  const info = loadIndex().routes['22'];
  if (!info) return;
  const dir0 = info['0'];
  const pattern = { pid: 'test22-0', points: [{ lat: 0, lon: 0 }, { lat: dir0.terminalLat, lon: dir0.terminalLon }] };
  const hw = expectedHeadwayMin('22', pattern, SUN_1AM);
  assert.ok(hw != null && hw > 0, `expected non-null positive headway, got ${hw}`);
});
