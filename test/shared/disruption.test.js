const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText, buildClearPostText, evidenceLine } = require('../../src/shared/disruption');

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
  assert.match(text, /📡 No trains seen on this 13\.7-mi stretch in the last 18 min/);
  assert.match(text, /12 trains active elsewhere on the line/);
  assert.match(text, /Inferred from live train positions/);
});

test('evidenceLine falls back to lookback minutes when nothing was ever observed', () => {
  const text = evidenceLine({
    runLengthMi: 5.2,
    minutesSinceLastTrain: null,
    lookbackMin: 20,
    trainsOutsideRun: 0,
  });
  assert.match(text, /5\.2-mi stretch in the last 20 min/);
  assert.match(text, /\(0 trains active elsewhere on the line\)/);
});

test('evidenceLine uses singular "train active" when count is 1', () => {
  const text = evidenceLine({
    runLengthMi: 5.2,
    minutesSinceLastTrain: 17,
    lookbackMin: 20,
    trainsOutsideRun: 1,
  });
  assert.match(text, /\(1 train active elsewhere on the line\)/);
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
  assert.match(text, /^✅ Red Line trains running through Belmont ↔ Howard again\./);
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
  const text = buildClearPostText({
    line: 'blue',
    suspendedSegment: { from: "O'Hare", to: 'Forest Park' },
  }, { ctaAlertOpen: true });
  assert.ok(text.length < 300, `text was ${text.length} chars: ${text}`);
});

test('buildAltText still describes the dimmed segment', () => {
  const alt = buildAltText(observed());
  assert.match(alt, /Map of the Blue Line/);
  assert.match(alt, /between O'Hare and Forest Park/);
});
