#!/usr/bin/env node
// Preview the plain-English strings the web export derives from a bot
// observation — the detection sentence, resolution sentence, evidence bullets,
// and onset line — without running a bin (bins post to Bluesky on import) or
// touching the DB. It exercises the pure renderers in
// src/shared/observationDescribe.js directly, so you can iterate on wording or
// check a new signal shape in isolation.
//
// Usage:
//   node debugging/preview-bot-text.js --example roundup
//   node debugging/preview-bot-text.js --example pulse-cold
//   node debugging/preview-bot-text.js --example thin-gap
//   node debugging/preview-bot-text.js --file path/to/observation.json
//   echo '{"kind":"train","line":"red","detection_source":"roundup","signals":["gap"],"bullets":[{"source":"gap","detail":{"ratio":3.1,"fromStation":"Howard","toStation":"Jarvis"}}]}' \
//     | node debugging/preview-bot-text.js
//
// The input is one observation row shaped like what bin/export-web.js feeds the
// renderers: { kind, line, detection_source, signals, bullets, evidence,
// from_station, to_station, ts, onset_ts }.

const Fs = require('node:fs');
const {
  describeBotObservation,
  describeBotResolution,
  describeBotEvidenceBullets,
  describeBotOnset,
  observationSignals,
} = require('../src/shared/observationDescribe');

// Realistic fixtures mirroring rows the export builds. `ts`/`onset_ts` are
// relative to now so the onset gate (>=5 min before post) fires for the
// absence-style examples.
const NOW = Date.now();
const EXAMPLES = {
  // Multi-signal train roundup: gap (now carrying its flanking stretch) + ghost.
  roundup: {
    kind: 'train',
    line: 'red',
    detection_source: 'roundup',
    signals: ['ghost', 'gap'],
    bullets: [
      { source: 'ghost', detail: { missing: 5, expected: 13 } },
      { source: 'gap', detail: { ratio: 3.12, fromStation: 'Howard', toStation: 'Jarvis' } },
    ],
  },
  // Train pulse-cold: a stretch of line with no trains, back-dated onset.
  'pulse-cold': {
    kind: 'train',
    line: 'brown',
    detection_source: 'pulse-cold',
    from_station: 'Belmont',
    to_station: 'Kimball',
    ts: NOW,
    onset_ts: NOW - 18 * 60 * 1000,
    evidence: {
      runLengthMi: 4.2,
      coldStations: 6,
      minutesSinceLastTrain: 18,
      expectedTrains: 3,
      headwayMin: 6,
    },
  },
  // Low-frequency bus route gone silent for a full headway window.
  'thin-gap': {
    kind: 'bus',
    line: '52',
    detection_source: 'thin-gap',
    ts: NOW,
    onset_ts: NOW - 62 * 60 * 1000,
    evidence: { windowMin: 62, headwayMin: 30, missedTrips: 2, lookbackMin: 62 },
  },
};

function loadInput(args) {
  if (args.example) {
    const ex = EXAMPLES[args.example];
    if (!ex) {
      console.error(
        `Unknown --example "${args.example}". Choices: ${Object.keys(EXAMPLES).join(', ')}`,
      );
      process.exit(1);
    }
    return ex;
  }
  const json = args.file ? Fs.readFileSync(args.file, 'utf8') : Fs.readFileSync(0, 'utf8');
  if (!json.trim()) {
    console.error('No input. Use --example <name>, --file <path>, or pipe JSON on stdin.');
    process.exit(1);
  }
  return JSON.parse(json);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const obs = loadInput(args);

  const line = `${'─'.repeat(60)}`;
  console.log(line);
  console.log(
    `kind=${obs.kind} line=${obs.line} source=${obs.detection_source} signals=[${observationSignals(obs).join(', ')}]`,
  );
  console.log(line);
  console.log('\nDetection:');
  console.log(`  ${describeBotObservation(obs) ?? '(none)'}`);

  const bullets = describeBotEvidenceBullets(obs);
  console.log('\nEvidence bullets:');
  if (bullets?.length) for (const b of bullets) console.log(`  • ${b}`);
  else console.log('  (none)');

  console.log('\nOnset:');
  console.log(`  ${describeBotOnset(obs) ?? '(none)'}`);

  console.log('\nResolution:');
  console.log(`  ${describeBotResolution(obs) ?? '(none)'}`);
  console.log('');
}

main();
