#!/usr/bin/env node
const Fs = require('node:fs');
const Path = require('node:path');
const Database = require('better-sqlite3');

const DB = process.env.HISTORY_DB || '/home/cailin/Development/cta-insights/state/history.sqlite';
const OUT = process.argv[2] || '/tmp/pulse-fixtures';
Fs.mkdirSync(OUT, { recursive: true });
const db = new Database(DB, { readonly: true });

// Each fixture: { name, line, now, headwayMin, lookbackHours, expectedResult, observations[] }
const FIXTURES = [
  {
    name: 'purple-2026-05-13-1950-sedgwick-quincy',
    line: 'p',
    now: 1778719807568,
    headwayMin: 10.333333333333334,
    expectedResult: 'no-candidates',
    note: 'Loop trunk cold after PM Express end; last NB deadhead at 19:24',
  },
  {
    name: 'purple-2026-05-11-1050-chicago-quincy',
    line: 'p',
    now: 1778514606675,
    headwayMin: 10,
    expectedResult: 'no-candidates',
    note: 'Loop trunk cold after AM Express end',
  },
  {
    name: 'purple-2026-05-12-1555-central-noyes',
    line: 'p',
    now: 1778619307130,
    headwayMin: 7.625,
    expectedResult: 'no-candidates',
    note: 'Linden turnaround trDr-flip dead zone; outbound-branch FP',
  },
  {
    name: 'purple-2026-05-14-1015-howard-belmont',
    line: 'p',
    now: 1778771708572,
    headwayMin: 10,
    expectedResult: 'no-candidates',
    note: 'Inbound express segment cold while shuttles + a few express trains active; FP at 10:15 AM',
  },
  {
    name: 'purple-2026-05-15-1924-howard-armitage',
    line: 'p',
    now: 1778891042184,
    headwayMin: 10.5,
    expectedResult: 'no-candidates',
    note: 'PM Express trailing edge on branch-1-inbound; last NB Loop-trunk deadhead cleared, shuttle continues Howard↔Linden, detector still flagged Howard→Armitage cold',
  },
];

const LOOKBACK_MS = 3 * 60 * 60 * 1000; // generous: covers 2h ramp-up + active-range window

const stmt = db.prepare(`
  SELECT ts, vehicle_id AS rn, direction AS trDr, destination, lat, lon
  FROM observations
  WHERE kind='train' AND route=? AND ts BETWEEN ? AND ?
    AND lat IS NOT NULL AND lon IS NOT NULL
  ORDER BY ts
`);

for (const f of FIXTURES) {
  const since = f.now - LOOKBACK_MS;
  const rows = stmt.all(f.line, since, f.now);
  const out = {
    name: f.name,
    note: f.note,
    line: f.line,
    now: f.now,
    headwayMin: f.headwayMin,
    expectedResult: f.expectedResult,
    observationCount: rows.length,
    observations: rows.map((r) => ({
      ts: r.ts,
      rn: String(r.rn),
      trDr: r.trDr,
      destination: r.destination,
      lat: r.lat,
      lon: r.lon,
    })),
  };
  const path = Path.join(OUT, `${f.name}.json`);
  Fs.writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`wrote ${path} (${rows.length} obs)`);
}
