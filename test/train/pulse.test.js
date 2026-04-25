const test = require('node:test');
const assert = require('node:assert');
const { detectDeadSegments } = require('../../src/train/pulse');
const { straightLine, pointAtFt } = require('../helpers');

const TOTAL_FT = 80000; // ~15 mi straight line
const trainLines = { red: [straightLine(TOTAL_FT)] };

// Build stations evenly along the line every ~2000 ft.
function buildStations(line = 'red') {
  const out = [];
  for (let ft = 0; ft <= TOTAL_FT; ft += 2000) {
    const p = pointAtFt(TOTAL_FT, ft);
    out.push({ name: `S${ft}`, lat: p.lat, lon: p.lon, lines: [line] });
  }
  return out;
}

function position(ft, ts) {
  const p = pointAtFt(TOTAL_FT, ft);
  return { ts, lat: p.lat, lon: p.lon, rn: `r${ft}`, trDr: '1' };
}

test('flags a long cold stretch in the middle of the line', () => {
  const now = 1_700_000_000_000;
  const stations = buildStations();
  // Plenty of recent trains near the ends, none in the middle.
  const recent = [];
  for (let ft = 6000; ft <= 20000; ft += 2000) recent.push(position(ft, now - 2 * 60 * 1000));
  for (let ft = 55000; ft <= 74000; ft += 2000) recent.push(position(ft, now - 3 * 60 * 1000));

  const candidates = detectDeadSegments({
    line: 'red',
    observations: [],
    trainLines, stations,
    headwayMin: 7,
    now,
    opts: { recentPositions: recent, minRunFt: 5000 },
  });

  assert.ok(candidates.length >= 1, 'should flag a candidate');
  const c = candidates[0];
  assert.ok(c.runLoFt > 20000 && c.runHiFt < 55000, `run bounds unexpected: ${c.runLoFt}-${c.runHiFt}`);
  assert.ok(c.fromStation && c.toStation);
});

test('does not flag when trains are distributed across the line', () => {
  const now = 1_700_000_000_000;
  const stations = buildStations();
  const recent = [];
  for (let ft = 4000; ft <= TOTAL_FT - 4000; ft += 4000) {
    recent.push(position(ft, now - 1 * 60 * 1000));
  }
  const candidates = detectDeadSegments({
    line: 'red',
    observations: [],
    trainLines, stations,
    headwayMin: 7,
    now,
    opts: { recentPositions: recent },
  });
  assert.equal(candidates.length, 0);
});

test('ignores terminal zones at both ends', () => {
  const now = 1_700_000_000_000;
  const stations = buildStations();
  // All trains bunched in the middle — both terminals are cold, but that
  // should be excluded by the terminal-zone filter.
  const recent = [];
  for (let ft = 30000; ft <= 50000; ft += 2000) recent.push(position(ft, now - 1 * 60 * 1000));
  const candidates = detectDeadSegments({
    line: 'red',
    observations: [],
    trainLines, stations,
    headwayMin: 7,
    now,
    opts: { recentPositions: recent, minRunFt: 5000 },
  });
  // Either no candidates (terminals excluded) or candidates bounded away from
  // the very ends — what matters is the detector doesn't flag the terminal.
  for (const c of candidates) {
    assert.ok(c.runLoFt > 0);
    assert.ok(c.runHiFt < TOTAL_FT);
  }
});
