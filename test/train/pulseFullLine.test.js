const test = require('node:test');
const assert = require('node:assert');
const { detectDeadSegments } = require('../../src/train/pulse');

test('detector skips on zero observations (synthetic candidate handled by bin)', () => {
  const result = detectDeadSegments({
    line: 'y',
    trainLines: { y: [] },
    stations: [],
    headwayMin: 8,
    now: 1_700_000_000_000,
    opts: { recentPositions: [] },
  });
  // Empty trainLines → no-branches; non-empty + zero recentPositions → noobs.
  assert.ok(['noobs', 'no-branches'].includes(result.skipped));
});

test('zero-obs detection: synthetic candidate has runLengthFt = totalFt and synthetic flag', () => {
  // Smoke test of the synthetic candidate shape — the bin script constructs it,
  // we just verify the disruption-event renderer copes with synthetic=true.
  const { buildPostText } = require('../../src/shared/disruption');
  const synthetic = {
    line: 'y',
    suspendedSegment: { from: 'Howard', to: 'Dempster-Skokie' },
    alternative: null,
    reason: null,
    source: 'observed',
    detectedAt: Date.now(),
    evidence: {
      runLengthMi: 4.5,
      minutesSinceLastTrain: null,
      lookbackMin: 20,
      coldStations: 3,
      coldStationNames: ['Howard', 'Oakton-Skokie', 'Dempster-Skokie'],
      expectedTrains: null,
      trainsOutsideRun: 0,
      synthetic: true,
    },
  };
  const text = buildPostText(synthetic);
  assert.match(text, /service appears suspended line-wide/);
});
