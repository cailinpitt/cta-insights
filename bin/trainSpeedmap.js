#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const _ = require('lodash');
const argv = require('minimist')(process.argv.slice(2));

const { LINE_NAMES, LINE_COLORS, ALL_LINES } = require('../src/trainApi');
const { collectTrains, computeTrainSamples, pickTargetDir, buildLinePolyline } = require('../src/trainSpeedmap');
const { binSamples, summarize, TRAIN_THRESHOLDS } = require('../src/speedmap');
const { renderTrainSpeedmap } = require('../src/map');
const { loginTrain, postWithImage } = require('../src/bluesky');
const { pruneOldAssets } = require('../src/cleanup');
const trainLines = require('../src/data/trainLines.json');

const NUM_BINS = 40;
const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_DURATION_MIN = 60;

function formatTimeCT(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago',
  });
}

function directionLabel(trDr) {
  // CTA train API uses '1' and '5' for the two directions.
  // We don't have a clean mapping, so just say the direction code.
  return trDr === '1' ? 'Direction 1' : 'Direction 5';
}

function buildPostText(line, trDr, summary, startTime, endTime) {
  const lineName = LINE_NAMES[line];
  const window = `${formatTimeCT(startTime)}–${formatTimeCT(endTime)} CT`;
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  return (
    `🚦 ${lineName} Line speedmap\n` +
    `${window} · average speed ${avg}\n\n` +
    `Each colored segment shows how fast trains were moving:\n` +
    `🟥 under 10 mph — stopped or crawling\n` +
    `🟧 10–25 mph — slow\n` +
    `🟨 25–40 mph — moderate\n` +
    `🟩 40+ mph — moving well`
  );
}

function buildAltText(line, summary) {
  const lineName = LINE_NAMES[line];
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  return `Speedmap of the CTA ${lineName} Line over a one-hour window, with route segments colored by average train speed. Overall average: ${avg}. Red segments indicate stopped or crawling trains under 10 mph, orange under 25, yellow under 40, green 40 and above.`;
}

async function main() {
  pruneOldAssets();
  // Yellow line is very short with few trains — exclude by default.
  const eligibleLines = ALL_LINES.filter((l) => l !== 'y');
  const line = argv.line || _.sample(eligibleLines);
  const durationMin = argv.duration ? Number(argv.duration) : DEFAULT_DURATION_MIN;
  const durationMs = durationMin * 60 * 1000;

  if (!LINE_NAMES[line]) {
    console.error(`Unknown line: ${line}`);
    process.exit(1);
  }

  const { points: linePoints, cumDist, totalFt } = buildLinePolyline(trainLines, line);
  if (linePoints.length < 2) {
    console.error(`No polyline data for ${line} line`);
    process.exit(1);
  }

  console.log(`Train speedmap for ${LINE_NAMES[line]} Line, ${durationMin}min window, poll every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Line polyline: ${linePoints.length} points, ${(totalFt / 5280).toFixed(1)} mi`);

  const startTime = new Date();
  const tracks = await collectTrains(line, durationMs, POLL_INTERVAL_MS);
  const endTime = new Date();

  const samplesByDir = computeTrainSamples(tracks, linePoints, cumDist);
  const targetDir = pickTargetDir(samplesByDir);
  if (!targetDir) {
    console.error('No speed samples collected — nothing to render');
    process.exit(1);
  }

  const samples = samplesByDir.get(targetDir);
  console.log(`Target direction ${targetDir} with ${samples.length} samples across ${tracks.size} trains`);

  const binSpeeds = binSamples(samples, totalFt, NUM_BINS);
  const summary = summarize(binSpeeds, TRAIN_THRESHOLDS);

  console.log(`Avg ${summary.avg?.toFixed(1)} mph · red=${summary.red} orange=${summary.orange} yellow=${summary.yellow} green=${summary.green}`);

  const lineColor = LINE_COLORS[line];
  const image = await renderTrainSpeedmap(linePoints, cumDist, binSpeeds, lineColor);
  const text = buildPostText(line, targetDir, summary, startTime, endTime);
  const alt = buildAltText(line, summary);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `train-speedmap-${line}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginTrain();
  const url = await postWithImage(agent, text, image, alt);
  console.log(`Posted: ${url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
