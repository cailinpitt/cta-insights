const test = require('node:test');
const assert = require('node:assert');
const { detectDeadSegments } = require('../../src/train/pulse');
const { buildLineBranches, inLoopTrunk } = require('../../src/train/speedmap');
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
      const lat = p[0] !== undefined ? p[0] : p.lat;
      const lon = p[1] !== undefined ? p[1] : p.lon;
      // Skip Loop-trunk points: those bins now accept either trDr by design
      // (Loop apex flips direction code mid-circuit). Bug 16 was about
      // inbound trains warming Kimball-spur outbound bins, so we keep the
      // phantom inbound trains on non-Loop-trunk geometry only.
      if (inLoopTrunk(lat, lon)) continue;
      observations.push({
        ts,
        lat,
        lon,
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

test('Pulse on Brown inbound: outbound-tagged trains on Loop trunk warm inbound bins', () => {
  // Real-world false positive (2026-05-02): TrainTracker flips direction
  // from inbound → outbound at the Loop apex (~Tower 18), so a Brown train
  // still physically traversing the south Loop trunk (Wells/Library/Wabash)
  // gets tagged trDr='1' (outbound) for the rest of the circuit. The strict
  // inbound filter excluded those obs and the south Loop went falsely cold,
  // firing a Washington/Wells → Library alert while trains were visibly
  // present. Loop-trunk bins now accept either trDr.
  const branches = buildLineBranches(trainLines, 'brn');
  const inbound = branches.find((b) => b.directionHint === 'inbound');
  assert.ok(inbound);

  const now = 1_700_000_000_000;
  const observations = [];
  const tsCount = 12;
  for (let i = 0; i < tsCount; i++) {
    const ts = now - (20 - i) * 60_000;
    for (let j = 0; j < inbound.points.length; j += Math.ceil(inbound.points.length / 24)) {
      const p = inbound.points[j];
      const lat = p[0] !== undefined ? p[0] : p.lat;
      const lon = p[1] !== undefined ? p[1] : p.lon;
      // On the Loop trunk, drop outbound-tagged obs (mid-circuit flip).
      // Off-trunk, drop inbound-tagged obs so the Kimball spur is also warmed
      // (so coverage gate passes and a candidate could fire if Loop bins
      // were treated as cold).
      observations.push({
        ts,
        lat,
        lon,
        rn: `r${i}-${j}`,
        trDr: inLoopTrunk(lat, lon) ? '1' : '5',
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

  // No inbound candidate should fire on Loop-trunk territory — outbound-tagged
  // trains warm those bins under the new behavior.
  for (const c of candidates) {
    if (c.direction !== 'branch-1-inbound') continue;
    // If something does fire on inbound, ensure it's not in the Loop-trunk
    // section we're testing. Endpoint stations should be off-trunk.
    const trunkStations = [
      'Washington/Wells',
      'Quincy',
      'LaSalle/Van Buren',
      'Harold Washington Library-State/Van Buren',
      'Adams/Wabash',
      'Madison/Wabash',
      'Washington/Wabash',
      'Lake',
      'Clark/Lake',
      'State/Lake',
    ];
    assert.ok(
      !trunkStations.includes(c.from),
      `inbound candidate should not start at Loop-trunk station ${c.from}`,
    );
    assert.ok(
      !trunkStations.includes(c.to),
      `inbound candidate should not end at Loop-trunk station ${c.to}`,
    );
  }
});

// Real-world false positive 2026-05-10: at 06:10 Brown branch-0-outbound
// fired Francisco→Montrose because the segment was empty in the 20-min
// lookback. But vehicle 401 — the day's first outbound train — was still
// climbing through Belmont, miles short of the cold stretch. The ramp-up
// veto is supposed to catch this. The original implementation only checked
// "max cumDist reached < runLoFt", which is the correct test for INBOUND
// trains (they progress with increasing cumDist) but inverted for OUTBOUND
// trains (loop-line pruned polylines start at the outer terminal, so
// outbound trains progress with DECREASING cumDist). Train 401 at Belmont
// had a higher cumDist than runLoFt, so the check returned "reached" and
// the FP posted.
test('Ramp-up veto: outbound — early-morning train short of cold run suppresses (Brown 06:10 case)', () => {
  const branches = buildLineBranches(trainLines, 'brn');
  const outbound = branches.find((b) => b.directionHint === 'outbound');
  assert.ok(outbound);

  const now = 1_700_000_000_000;
  const lookbackMs = 20 * 60 * 1000;
  const points = outbound.points;

  // Need enough coverage on the Loop-end half of the branch for the
  // coverage gate (≥50% of corridor bins covered) to pass. Drop dir=1
  // observations from the Loop apex down to ~mid-line — these are trains
  // partway through their first outbound run, all still at high cumDist.
  // The Kimball-end half (Francisco↔Montrose↔Irving Park) stays empty —
  // that's the cold stretch the detector will pick up.
  const observations = [];
  const longLookbackPositions = [];
  // Walk the polyline backward (Loop end first) for ~70% of points.
  const startIdx = Math.floor(points.length * 0.3); // skip first 30% (Kimball end)
  for (let i = 0; i < 12; i++) {
    const ts = now - (20 - i) * 60_000;
    for (let j = startIdx; j < points.length; j += 2) {
      const p = points[j];
      const lat = p[0] !== undefined ? p[0] : p.lat;
      const lon = p[1] !== undefined ? p[1] : p.lon;
      observations.push({ ts, lat, lon, rn: `r${i}-${j}`, trDr: '1' });
    }
  }
  // Long lookback (2h): same shape — no outbound train has reached the
  // Kimball-end stretch in the past 2 hours either.
  for (let i = 0; i < 24; i++) {
    const ts = now - (120 - i * 5) * 60_000;
    for (let j = startIdx; j < points.length; j += 2) {
      const p = points[j];
      const lat = p[0] !== undefined ? p[0] : p.lat;
      const lon = p[1] !== undefined ? p[1] : p.lon;
      longLookbackPositions.push({ ts, lat, lon, trDr: '1' });
    }
  }

  const { candidates } = detectDeadSegments({
    line: 'brn',
    trainLines,
    stations: trainStations,
    headwayMin: 8,
    now,
    opts: { recentPositions: observations, longLookbackPositions, lookbackMs },
  });

  // No outbound candidate should survive the ramp-up veto: even though the
  // Kimball-end stretch is genuinely empty in the lookback, the day's
  // outbound trains haven't reached it yet (min cumDist of dir=1 obs > runHiFt).
  for (const c of candidates) {
    assert.notEqual(
      c.direction,
      'branch-0-outbound',
      `outbound candidate ${c.from}→${c.to} should have been suppressed by ramp-up veto`,
    );
  }
});

// Mirror of the above for inbound: when no dir=5 obs has reached the cold
// run's near edge (runLoFt) in 2h, suppress. This is the case the original
// code already handled correctly — keep it covered so a future refactor
// doesn't break it.
test('Ramp-up veto: inbound — early-morning train short of cold run suppresses', () => {
  const branches = buildLineBranches(trainLines, 'brn');
  const inbound = branches.find((b) => b.directionHint === 'inbound');
  assert.ok(inbound);

  const now = 1_700_000_000_000;
  const lookbackMs = 20 * 60 * 1000;
  const points = inbound.points;

  // Inbound trains progress with increasing cumDist. Drop dir=5 obs only
  // on the Kimball-end half of the polyline (~first 70%), leaving the
  // Loop-end stretch genuinely empty in the lookback. Inbound trains
  // haven't reached the Loop end yet.
  const observations = [];
  const longLookbackPositions = [];
  const endIdx = Math.floor(points.length * 0.7);
  for (let i = 0; i < 12; i++) {
    const ts = now - (20 - i) * 60_000;
    for (let j = 0; j < endIdx; j += 2) {
      const p = points[j];
      const lat = p[0] !== undefined ? p[0] : p.lat;
      const lon = p[1] !== undefined ? p[1] : p.lon;
      observations.push({ ts, lat, lon, rn: `r${i}-${j}`, trDr: '5' });
    }
  }
  for (let i = 0; i < 24; i++) {
    const ts = now - (120 - i * 5) * 60_000;
    for (let j = 0; j < endIdx; j += 2) {
      const p = points[j];
      const lat = p[0] !== undefined ? p[0] : p.lat;
      const lon = p[1] !== undefined ? p[1] : p.lon;
      longLookbackPositions.push({ ts, lat, lon, trDr: '5' });
    }
  }

  const { candidates } = detectDeadSegments({
    line: 'brn',
    trainLines,
    stations: trainStations,
    headwayMin: 8,
    now,
    opts: { recentPositions: observations, longLookbackPositions, lookbackMs },
  });

  for (const c of candidates) {
    assert.notEqual(
      c.direction,
      'branch-1-inbound',
      `inbound candidate ${c.from}→${c.to} should have been suppressed by ramp-up veto`,
    );
  }
});
