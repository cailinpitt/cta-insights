#!/usr/bin/env node
// Full-fidelity replay: runs detection + state-machine + post text + image
// rendering against historical observations. Used to inspect what the bot
// would have posted during a given window without touching Bluesky.
//
// Output: tmp/replay-images/<line>-<direction>-<ts>.jpg + console post text.
//
// Usage:
//   HISTORY_DB_PATH=tmp/server-history.sqlite \
//   node scripts/replay-incident.js --start=2026-05-03T20:30:00Z --end=2026-05-03T23:30:00Z

require('../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');
const minimist = require('minimist');
const { detectDeadSegments } = require('../src/train/pulse');
const { detectHeldClusters } = require('../src/train/heldClusters');
const { ALL_LINES, LINE_COLORS, lineLabel, LINE_NAMES } = require('../src/train/api');
const {
  expectedTrainHeadwayMin,
  expectedTrainHeadwayMinAnyDir,
  expectedTrainActiveTripsAnyDir,
  expectedTrainDispatchesInWindow,
} = require('../src/shared/gtfs');
const { getRecentTrainPositions, getLineCorridorBbox } = require('../src/shared/observations');
const { renderDisruption } = require('../src/map');
const { buildPostText, buildAltText, buildClearPostText } = require('../src/shared/disruption');
const trainLines = require('../src/train/data/trainLines.json');
const trainStations = require('../src/train/data/trainStations.json');

const STEP_MS = 5 * 60 * 1000;
const LOOKBACK_MS = 20 * 60 * 1000;
const COLD_HEADWAY_MULT_FOR_LOOKBACK = 2.5;
const RAMP_UP_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const CORRIDOR_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const COLD_START_RECENT_MS = 60 * 60 * 1000;
const MIN_CONSECUTIVE_TICKS = 2;
const CLEAR_TICKS_TO_RESET = 3;
const OUT_DIR = Path.join(__dirname, '..', 'tmp', 'replay-images');

function safeHeadway(line, now) {
  try {
    const direct = expectedTrainHeadwayMin(line, null, new Date(now));
    if (direct != null) return direct;
    return expectedTrainHeadwayMinAnyDir(line, new Date(now));
  } catch (_e) {
    return null;
  }
}

function overlapFraction(a, b) {
  if (!a || !b) return 0;
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (hi <= lo) return 0;
  const shorter = Math.min(a.hi - a.lo, b.hi - b.lo);
  return shorter > 0 ? (hi - lo) / shorter : 0;
}

function fmtTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', 'Z');
}

function ctTime(ms) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function detectForLine(line, now) {
  const headwayMin = safeHeadway(line, now);
  let expectedAnyDir = 0;
  try {
    expectedAnyDir = expectedTrainActiveTripsAnyDir(line, new Date(now));
  } catch (_e) {
    expectedAnyDir = 0;
  }
  if (expectedAnyDir < 1) return { status: 'wind-down', candidates: [] };

  const LOOKBACK_BUFFER_MS = 5 * 60 * 1000;
  const headwayDrivenLookbackMs = headwayMin
    ? COLD_HEADWAY_MULT_FOR_LOOKBACK * headwayMin * 60 * 1000 + LOOKBACK_BUFFER_MS
    : 0;
  const lineLookbackMs = Math.max(LOOKBACK_MS, headwayDrivenLookbackMs);
  const sinceTs = now - lineLookbackMs;
  const allRecent = getRecentTrainPositions(sinceTs).filter((r) => r.ts <= now);
  const lineRecent = allRecent.filter((r) => r.line === line);
  const corridorBbox = getLineCorridorBbox(line, now - CORRIDOR_LOOKBACK_MS);
  const recentlyActive = !!getLineCorridorBbox(line, now - COLD_START_RECENT_MS);
  if (!recentlyActive) return { status: 'no-recent-obs', candidates: [] };
  const longRecent = getRecentTrainPositions(now - RAMP_UP_LOOKBACK_MS)
    .filter((r) => r.ts <= now)
    .filter((r) => r.line === line);
  const dispatches = (() => {
    try {
      return expectedTrainDispatchesInWindow(line, null, sinceTs, now);
    } catch (_e) {
      return null;
    }
  })();
  const motionInputs = lineRecent.map((r) => ({
    ts: r.ts,
    lat: r.lat,
    lon: r.lon,
    rn: r.rn,
    trDr: r.trDr,
  }));
  const cold = detectDeadSegments({
    line,
    trainLines,
    stations: trainStations,
    headwayMin,
    now,
    opts: {
      lookbackMs: lineLookbackMs,
      corridorBbox,
      expectedDispatchesInWindow: dispatches,
      recentPositions: motionInputs,
      longLookbackPositions: longRecent.map((r) => ({
        ts: r.ts,
        lat: r.lat,
        lon: r.lon,
        trDr: r.trDr,
      })),
    },
  });
  const held = detectHeldClusters({
    line,
    trainLines,
    stations: trainStations,
    headwayMin,
    now,
    recent: motionInputs,
  });
  return {
    status: 'evaluated',
    headwayMin,
    skipped: cold.skipped,
    candidates: [...(cold.candidates || []), ...(held.candidates || [])],
  };
}

async function main() {
  const argv = minimist(process.argv.slice(2));
  const start = Date.parse(argv.start);
  const end = Date.parse(argv.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    console.error('Usage: replay-incident.js --start=ISO --end=ISO');
    process.exit(2);
  }
  Fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Replay window: ${fmtTs(start)} → ${fmtTs(end)} (5-min steps)\n`);

  // Per-(line, direction) state machine — mirrors bin/train/pulse.js.
  const state = new Map();
  const events = [];

  for (let now = start; now <= end; now += STEP_MS) {
    const ctNow = ctTime(now);
    for (const line of ALL_LINES) {
      const detection = detectForLine(line, now);
      if (detection.status !== 'evaluated') continue;

      const candidates = detection.candidates || [];
      const seenDirs = new Set();
      // Sort: held > cold for same line
      candidates.sort((a, b) => (b.kind === 'held' ? 1 : 0) - (a.kind === 'held' ? 1 : 0));

      for (const c of candidates) {
        if (seenDirs.has(c.direction)) continue;
        seenDirs.add(c.direction);
        const key = `${line}:${c.direction}`;
        const prior = state.get(key);
        let consecutive = 1;
        if (prior?.runLoFt != null) {
          const frac = overlapFraction(
            { lo: prior.runLoFt, hi: prior.runHiFt },
            { lo: c.runLoFt, hi: c.runHiFt },
          );
          if (frac >= 0.5) consecutive = (prior.consecutiveTicks || 0) + 1;
        }
        const activePostTick = prior?.activePostTick || null;

        if (activePostTick != null) {
          // Already posted; refresh state, no re-render
          state.set(key, { ...c, consecutiveTicks: consecutive, clearTicks: 0, activePostTick });
          continue;
        }

        if (consecutive < MIN_CONSECUTIVE_TICKS) {
          state.set(key, { ...c, consecutiveTicks: consecutive, clearTicks: 0 });
          console.log(
            `[${ctNow}] ${lineLabel(line)}/${c.direction} candidate ${c.fromStation.name}→${c.toStation.name} tick ${consecutive}/${MIN_CONSECUTIVE_TICKS} (kind=${c.kind || 'cold'})`,
          );
          continue;
        }

        // WOULD POST.
        const disruption = {
          line,
          suspendedSegment: { from: c.fromStation.name, to: c.toStation.name },
          directionHint: c.directionHint || null,
          directionDestinationName: c.directionDestinationName || null,
          alternative: null,
          reason: null,
          source: c.kind === 'held' ? 'observed-held' : 'observed',
          kind: c.kind || 'cold',
          detectedAt: now,
          evidence: {
            runLengthMi: Math.round((c.runLengthFt / 5280) * 10) / 10,
            minutesSinceLastTrain:
              c.lastSeenInRunMs != null ? Math.round((now - c.lastSeenInRunMs) / 60000) : null,
            lookbackMin: Math.round(c.lookbackMs / 60000),
            coldThresholdMin: Math.round(c.coldThresholdMs / 60000),
            trainsOutsideRun: c.trainsOutsideRun,
            coldStations: c.coldStations,
            coldStationNames: c.coldStationNames,
            expectedTrains: c.expectedTrains,
            headwayMin: c.headwayMin,
            synthetic: c.synthetic === true,
            held: c.heldEvidence || null,
          },
        };
        const text = buildPostText(disruption, { ctaAlertOpen: false });
        const alt = buildAltText(disruption);
        let imagePath = '(render-failed)';
        try {
          const image = await renderDisruption({
            disruption,
            trainLines,
            lineColors: LINE_COLORS,
            trains: [],
            stations: trainStations,
          });
          imagePath = Path.join(OUT_DIR, `${ctNow.replace(':', '')}-${line}-${c.direction}.jpg`);
          Fs.writeFileSync(imagePath, image);
        } catch (e) {
          imagePath = `(render-error: ${e.message})`;
        }

        console.log(
          `\n========== [${ctNow}] WOULD POST: ${lineLabel(line)}/${c.direction} (kind=${c.kind || 'cold'}) ==========`,
        );
        console.log(text);
        console.log(`\nALT: ${alt}`);
        console.log(`IMAGE: ${imagePath}\n`);

        events.push({
          ts: now,
          ctNow,
          line,
          direction: c.direction,
          kind: c.kind || 'cold',
          from: c.fromStation.name,
          to: c.toStation.name,
          imagePath,
        });

        state.set(key, {
          ...c,
          consecutiveTicks: consecutive,
          clearTicks: 0,
          activePostTick: now,
        });
      }

      // Clear-tick advancement for prior-state directions not seen this tick
      for (const [key, s] of state) {
        if (!key.startsWith(`${line}:`)) continue;
        const dir = key.slice(line.length + 1);
        if (seenDirs.has(dir)) continue;
        const clearTicks = (s.clearTicks || 0) + 1;
        if (clearTicks >= CLEAR_TICKS_TO_RESET && s.activePostTick != null) {
          const clearText = buildClearPostText(
            { line, suspendedSegment: { from: s.fromStation.name, to: s.toStation.name } },
            { ctaAlertOpen: false },
          );
          console.log(`\n--- [${ctNow}] CLEAR ${lineLabel(line)}/${dir} ---`);
          console.log(clearText);
          state.delete(key);
        } else {
          state.set(key, { ...s, clearTicks });
        }
      }
    }
  }

  console.log('\n\n========== REPLAY SUMMARY ==========');
  console.log(`Window: ${fmtTs(start)} → ${fmtTs(end)}`);
  console.log(`Total posts that would have fired: ${events.length}`);
  for (const e of events) {
    console.log(
      `  [${e.ctNow}] ${LINE_NAMES[e.line] || e.line}/${e.direction} (${e.kind}): ${e.from} → ${e.to}`,
    );
    console.log(`    image: ${e.imagePath}`);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
