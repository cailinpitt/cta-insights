#!/usr/bin/env node
// Manual disruption poster. Takes CTA alert info as CLI args, constructs a
// Disruption object, renders a map and posts from the train account. Shares
// everything downstream of the Disruption object with (future) automated
// pulse detection — the auto detector just builds a Disruption from live
// data and calls the same renderer + post builder.

require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2), {
  boolean: ['dry-run', 'no-trains'],
});

const { LINE_COLORS, getAllTrainPositions } = require('../../src/train/api');
const { loginAlerts, postWithImage } = require('../../src/shared/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { buildPostText, buildAltText } = require('../../src/shared/disruption');
const { renderDisruption } = require('../../src/map');
const { recordDisruption } = require('../../src/shared/history');
const trainLines = require('../../src/train/data/trainLines.json');
const trainStations = require('../../src/train/data/trainStations.json');

function usage() {
  console.error(`Usage: disruption.js --line <code>
  --suspended-from <station> --suspended-to <station>
  [--running-from <station> --running-to <station>]   (short-turned trains)
  [--shuttle-from  <station> --shuttle-to  <station>] (shuttle buses)
  [--reason "..."] [--source cta-alert|observed]
  [--no-trains]   (skip the live-positions fetch)
  [--dry-run]`);
}

function buildAlternative() {
  if (argv['running-from'] && argv['running-to']) {
    return { type: 'shortTurn', from: argv['running-from'], to: argv['running-to'] };
  }
  if (argv['shuttle-from'] && argv['shuttle-to']) {
    return { type: 'shuttle', from: argv['shuttle-from'], to: argv['shuttle-to'] };
  }
  return null;
}

async function main() {
  setup();
  const line = argv.line;
  const suspendedFrom = argv['suspended-from'];
  const suspendedTo = argv['suspended-to'];
  if (!line || !suspendedFrom || !suspendedTo) {
    usage();
    process.exit(2);
  }

  const disruption = {
    line,
    suspendedSegment: { from: suspendedFrom, to: suspendedTo },
    alternative: buildAlternative(),
    reason: argv.reason || null,
    source: argv.source || 'cta-alert',
    detectedAt: Date.now(),
  };

  let trains = [];
  if (!argv['no-trains']) {
    try {
      trains = await getAllTrainPositions();
    } catch (e) {
      console.warn(`Could not fetch live train positions: ${e.message}`);
    }
  }

  const image = await renderDisruption({
    disruption,
    trainLines,
    lineColors: LINE_COLORS,
    trains,
    stations: trainStations,
  });
  const text = buildPostText(disruption);
  const alt = buildAltText(disruption);

  if (argv['dry-run']) {
    const outPath = writeDryRunAsset(image, `disruption-${line}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginAlerts();
  const result = await postWithImage(agent, text, image, alt);
  console.log(`Posted: ${result.url}`);

  // Record so future pulse / CTA-alert flows can thread under this manual post.
  recordDisruption({
    kind: 'train',
    line: disruption.line,
    direction: 'manual',
    fromStation: disruption.suspendedSegment.from,
    toStation: disruption.suspendedSegment.to,
    source: argv.source === 'observed' ? 'observed' : 'cta-alert',
    posted: true,
    postUri: result.uri,
  });
}

runBin(main);
