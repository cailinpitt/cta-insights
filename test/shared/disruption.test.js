const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPostText,
  buildAltText,
  buildClearPostText,
  buildBusPostText,
  buildBusClearPostText,
  evidenceLine,
} = require('../../src/shared/disruption');

function observed(overrides = {}) {
  return {
    line: 'blue',
    suspendedSegment: { from: "O'Hare", to: 'Forest Park' },
    alternative: null,
    reason: null,
    source: 'observed',
    detectedAt: 1_700_000_000_000,
    evidence: {
      runLengthMi: 13.7,
      minutesSinceLastTrain: 18,
      lookbackMin: 20,
      coldThresholdMin: 15,
      trainsOutsideRun: 12,
    },
    ...overrides,
  };
}

test('buildPostText for observed disruption includes evidence sentence', () => {
  const text = buildPostText(observed());
  assert.match(text, /Between O'Hare and Forest Park\./);
  assert.match(text, /📡 No trains have moved through this 13\.7-mi stretch in the last 18 min/);
  assert.match(text, /12 trains still moving elsewhere on the line/);
  assert.match(text, /Trains may be holding in stations/);
  assert.match(text, /Inferred from live train positions/);
});

test('observed pulse title says "trains stalled" rather than "suspended"', () => {
  const text = buildPostText(observed());
  assert.match(text, /^🚇⚠️ Blue Line: trains stalled/);
  assert.doesNotMatch(text, /service suspended/);
  assert.doesNotMatch(text, /not seen/);
});

test('cta-alert title keeps the strong "service suspended" framing', () => {
  const text = buildPostText({
    line: 'red',
    suspendedSegment: { from: 'Belmont', to: 'Howard' },
    alternative: null,
    reason: null,
    source: 'cta-alert',
    detectedAt: 1_700_000_000_000,
  });
  assert.match(text, /^🚇⚠️ Red Line service suspended/);
});

test('evidenceLine falls back to lookback minutes when nothing was ever observed', () => {
  const text = evidenceLine({
    runLengthMi: 5.2,
    minutesSinceLastTrain: null,
    lookbackMin: 20,
    trainsOutsideRun: 0,
  });
  assert.match(text, /5\.2-mi stretch in the last 20 min/);
  assert.match(text, /\(0 trains still moving elsewhere on the line\)/);
});

test('evidenceLine uses singular "train still moving" when count is 1', () => {
  const text = evidenceLine({
    runLengthMi: 5.2,
    minutesSinceLastTrain: 17,
    lookbackMin: 20,
    trainsOutsideRun: 1,
  });
  assert.match(text, /\(1 train still moving elsewhere on the line\)/);
});

test('held-cluster post uses "service halted" title and "stationary" evidence', () => {
  const text = buildPostText({
    line: 'red',
    suspendedSegment: { from: 'Sox-35th', to: 'Roosevelt' },
    alternative: null,
    reason: null,
    source: 'observed-held',
    kind: 'held',
    detectedAt: 1_700_000_000_000,
    evidence: {
      runLengthMi: 4.8,
      minutesSinceLastTrain: null,
      lookbackMin: 20,
      coldStations: 5,
      coldStationNames: ['Sox-35th', 'Cermak-Chinatown', 'Roosevelt'],
      trainsOutsideRun: 0,
      held: { trainCount: 3, stationaryMs: 14 * 60 * 1000, cohesionFt: 4000 },
    },
  });
  assert.match(text, /^🚇🚨 Red Line: service halted around Sox-35th/);
  assert.match(text, /🛑 3 trains stationary 14\+ min near Sox-35th, Cermak-Chinatown, Roosevelt/);
  assert.match(text, /No moving trains nearby/);
});

test('cold-segment alt text describes "have not advanced through"', () => {
  const alt = buildAltText(observed());
  assert.match(alt, /have not advanced through that stretch/);
  assert.doesNotMatch(alt, /no trains.*were seen/);
});

test('held-cluster alt text describes "held in stations"', () => {
  const alt = buildAltText({
    line: 'red',
    suspendedSegment: { from: 'Sox-35th', to: 'Roosevelt' },
    source: 'observed-held',
    kind: 'held',
  });
  assert.match(alt, /held in stations/);
});

test('buildPostText omits evidence line for cta-alert source', () => {
  const text = buildPostText({
    line: 'blue',
    suspendedSegment: { from: 'Belmont', to: 'Howard' },
    alternative: null,
    reason: null,
    source: 'cta-alert',
    detectedAt: 1_700_000_000_000,
  });
  assert.doesNotMatch(text, /📡/);
  assert.match(text, /Per CTA/);
});

test('buildPostText is under 300 graphemes for typical observed pulse', () => {
  const text = buildPostText(observed());
  assert.ok(text.length < 300, `text was ${text.length} chars: ${text}`);
});

test('buildClearPostText (no CTA alert) says CTA never issued one', () => {
  const text = buildClearPostText({
    line: 'red',
    suspendedSegment: { from: 'Belmont', to: 'Howard' },
  });
  assert.match(text, /^🚇✅ Red Line trains running through Belmont ↔ Howard again\./);
  assert.match(text, /CTA hasn't issued an alert for this/);
});

test('buildClearPostText (CTA alert open) acknowledges the open alert', () => {
  const text = buildClearPostText(
    { line: 'red', suspendedSegment: { from: 'Belmont', to: 'Howard' } },
    { ctaAlertOpen: true },
  );
  assert.match(text, /CTA hasn't cleared their alert yet/);
  assert.doesNotMatch(text, /hasn't issued an alert/);
});

test('buildClearPostText stays under 300 graphemes for typical segments', () => {
  const text = buildClearPostText(
    {
      line: 'blue',
      suspendedSegment: { from: "O'Hare", to: 'Forest Park' },
    },
    { ctaAlertOpen: true },
  );
  assert.ok(text.length < 300, `text was ${text.length} chars: ${text}`);
});

test('buildAltText still describes the dimmed segment', () => {
  const alt = buildAltText(observed());
  assert.match(alt, /Map of the Blue Line/);
  assert.match(alt, /between O'Hare and Forest Park/);
});

test('buildBusPostText (no CTA alert) renders the strict-zero blackout shape', () => {
  const text = buildBusPostText(
    { route: '66', name: 'Chicago', lookbackMin: 25, minHeadwayMin: 8 },
    { ctaAlertOpen: false },
  );
  assert.match(text, /^🚌⚠️ #66 Chicago service appears suspended/);
  assert.match(text, /No buses observed on the route in the last 25 min/);
  assert.match(text, /currently scheduled every 8 min/);
  assert.match(text, /CTA hasn't issued an alert for this yet/);
});

test('buildBusPostText (CTA alert open) defers to the threaded CTA alert', () => {
  const text = buildBusPostText(
    { route: '79', name: '79th', lookbackMin: 25, minHeadwayMin: 7 },
    { ctaAlertOpen: true },
  );
  assert.match(text, /See CTA alert in this thread/);
  assert.doesNotMatch(text, /hasn't issued an alert/);
});

test('buildBusPostText omits headway clause when GTFS lookup returns null', () => {
  const text = buildBusPostText({
    route: '4',
    name: 'Cottage Grove',
    lookbackMin: 25,
    minHeadwayMin: null,
  });
  assert.match(text, /No buses observed on the route in the last 25 min\.\n/);
  assert.doesNotMatch(text, /scheduled every/);
});

test('buildBusPostText stays under 300 graphemes for typical inputs', () => {
  const text = buildBusPostText({
    route: '147',
    name: 'Outer DuSable Lake Shore Exp.',
    lookbackMin: 30,
    minHeadwayMin: 15,
  });
  assert.ok(text.length < 300, `text was ${text.length} chars: ${text}`);
});

test('buildBusClearPostText (no CTA alert) calls out absence', () => {
  const text = buildBusClearPostText({ route: '66', name: 'Chicago' }, { ctaAlertOpen: false });
  assert.match(text, /^🚌✅ #66 Chicago buses observed again\./);
  assert.match(text, /CTA hasn't issued an alert for this/);
});

test('buildBusClearPostText (CTA alert open) acknowledges the open alert', () => {
  const text = buildBusClearPostText({ route: '66', name: 'Chicago' }, { ctaAlertOpen: true });
  assert.match(text, /CTA hasn't cleared their alert yet/);
  assert.doesNotMatch(text, /hasn't issued an alert/);
});
