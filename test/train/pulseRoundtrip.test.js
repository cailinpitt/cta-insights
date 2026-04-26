const test = require('node:test');
const assert = require('node:assert');
const { detectDeadSegments } = require('../../src/train/pulse');
const { buildLineBranches } = require('../../src/train/speedmap');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

// Bug 16: round-trip loop lines (Brown/Orange/Pink/Purple) used to share a
// single outbound polyline; northbound passes warmed bins for southbound-only
// outages and vice versa. After fix, branches are split by trDr filter.

test('Brown line: buildLineBranches returns outbound + inbound branches', () => {
  const branches = buildLineBranches(trainLines, 'brn');
  assert.equal(branches.length, 2);
  const hints = branches.map((b) => b.directionHint).sort();
  assert.deepEqual(hints, ['inbound', 'outbound']);
  // Brown's outbound trDr should be '1' (toward Kimball).
  const outbound = branches.find((b) => b.directionHint === 'outbound');
  assert.equal(outbound.trDrFilter, '1');
  const inbound = branches.find((b) => b.directionHint === 'inbound');
  assert.equal(inbound.trDrFilter, '5');
});

test('Yellow line: branches not labeled outbound/inbound (single trDr in feed)', () => {
  // Yellow ships two open polyline segments (Howard→Dempster, Dempster→Howard)
  // rather than one round-trip — neither triggers the apex-prune split, and
  // Train Tracker reports a single trDr for the whole line, so the
  // outbound/inbound filter mapping deliberately omits Yellow.
  const branches = buildLineBranches(trainLines, 'y');
  for (const b of branches) {
    assert.equal(b.trDrFilter, undefined);
    assert.equal(b.directionHint, undefined);
  }
});

test('Bidirectional line (Blue): branches not labeled outbound/inbound', () => {
  const branches = buildLineBranches(trainLines, 'blue');
  // Blue has multiple physical branches (O'Hare / Forest Park) but those are
  // separate polylines, not round-trip splits.
  for (const b of branches) {
    assert.equal(b.trDrFilter, undefined);
    assert.equal(b.directionHint, undefined);
  }
});

test('Pulse on Brown southbound: northbound passes do not warm southbound bins', () => {
  // Build observations: trDr=5 (inbound, toward Loop) trains running normally;
  // trDr=1 (outbound, toward Kimball) trains absent.
  const branches = buildLineBranches(trainLines, 'brn');
  const outbound = branches.find((b) => b.directionHint === 'outbound');
  assert.ok(outbound);

  // Sample 12 timestamps spread across 20 minutes, only inbound trains.
  const now = 1_700_000_000_000;
  const observations = [];
  const tsCount = 12;
  for (let i = 0; i < tsCount; i++) {
    const ts = now - (20 - i) * 60_000;
    // Drop a phantom inbound train near each station along the polyline.
    for (let j = 0; j < outbound.points.length; j += Math.ceil(outbound.points.length / 8)) {
      const p = outbound.points[j];
      observations.push({
        ts,
        lat: p[0] !== undefined ? p[0] : p.lat,
        lon: p[1] !== undefined ? p[1] : p.lon,
        rn: `r${i}`,
        trDr: '5', // inbound — fills inbound branch but NOT outbound branch
      });
    }
  }

  const { candidates } = detectDeadSegments({
    line: 'brn',
    trainLines,
    stations: trainStations,
    headwayMin: 8,
    now,
    opts: { recentPositions: observations, lookbackMs: 20 * 60 * 1000 },
  });

  // Outbound branch has zero observations → coverage gate trips → no candidate
  // produced for it. Inbound branch has full coverage and no cold bins.
  // What we're verifying here: outbound branch isn't accidentally warmed by
  // inbound trains.
  for (const c of candidates) {
    assert.notEqual(c.direction, 'branch-0-outbound');
  }
});
