const test = require('node:test');
const assert = require('node:assert');
const {
  scoreSignals,
  buildRoundupText,
  describeSignal,
  buildResolutionText,
} = require('../bin/incident-roundup');

test('scoreSignals dedupes by source, takes max severity, adds persistence bonus', () => {
  const signals = [
    { source: 'gap', severity: 0.5, detail: null },
    { source: 'gap', severity: 0.8, detail: null },
    { source: 'pulse-cold', severity: 0.5, detail: null },
  ];
  const { total, bySource } = scoreSignals(signals);
  // gap: max severity 0.8, count 2 → bonus 0.15 → contribution 0.95
  assert.equal(bySource.get('gap').severity, 0.8);
  assert.equal(bySource.get('gap').count, 2);
  assert.equal(Math.round(bySource.get('gap').contribution * 100) / 100, 0.95);
  // pulse-cold: severity 0.5, count 1 → no bonus → contribution 0.5
  assert.equal(bySource.get('pulse-cold').severity, 0.5);
  assert.equal(bySource.get('pulse-cold').count, 1);
  assert.equal(bySource.get('pulse-cold').contribution, 0.5);
  // total = 0.95 + 0.5 = 1.45
  assert.equal(Math.round(total * 100) / 100, 1.45);
});

test('scoreSignals: persistence bonus caps at 0.5 per source', () => {
  // 10 ghost signals at sev 0.6 — count=10, bonus would be 0.15*9=1.35,
  // but capped at 0.5 → contribution = 0.6 + 0.5 = 1.1.
  const signals = Array.from({ length: 10 }, () => ({
    source: 'ghost',
    severity: 0.6,
    detail: null,
  }));
  const { total, bySource } = scoreSignals(signals);
  assert.equal(bySource.get('ghost').count, 10);
  assert.equal(bySource.get('ghost').bonus, 0.5);
  assert.equal(Math.round(bySource.get('ghost').contribution * 100) / 100, 1.1);
  assert.equal(Math.round(total * 100) / 100, 1.1);
});

test('scoreSignals: single-source sustained at sev=1 does not reach threshold alone', () => {
  // Bus/82-style: 8 bunching signals all at full severity. 1.0 + 0.5 cap =
  // 1.5, still below the 1.75 firing threshold. Roundup is correlation-only.
  const signals = Array.from({ length: 8 }, () => ({
    source: 'bunching',
    severity: 1.0,
    detail: null,
  }));
  const { total } = scoreSignals(signals);
  assert.equal(total, 1.5);
  assert.ok(total < 1.75, 'single-source sustained must stay sub-threshold');
});

test('scoreSignals: Blue-style two-source sub-threshold combo with repetition fires', () => {
  // Models 2026-05-05 16:08-16:37 Blue: 1 ghost @ 0.66, 2 gap @ 0.78 each.
  // Old formula: 0.66 + 0.78 = 1.44, well under 2.0. New formula: ghost
  // contribution = 0.66, gap contribution = 0.78 + 0.15 = 0.93, total 1.59.
  // Still below 1.75 here — but with one more repeat on either side it
  // would tip over. Documents the new boundary.
  const signals = [
    { source: 'ghost', severity: 0.66, detail: null },
    { source: 'gap', severity: 0.78, detail: null },
    { source: 'gap', severity: 0.78, detail: null },
  ];
  const { total } = scoreSignals(signals);
  assert.equal(Math.round(total * 100) / 100, 1.59);
});

test('scoreSignals: repeated cross-source signals tip over the 1.75 threshold', () => {
  // Same Blue shape but with one more ghost repeat: ghost count=2 (+0.15),
  // gap count=2 (+0.15) → 0.81 + 0.93 = 1.74, still just under. Add one
  // more ghost repeat (count=3, +0.30) → 0.96 + 0.93 = 1.89, fires.
  const signals = [
    { source: 'ghost', severity: 0.66, detail: null },
    { source: 'ghost', severity: 0.66, detail: null },
    { source: 'ghost', severity: 0.66, detail: null },
    { source: 'gap', severity: 0.78, detail: null },
    { source: 'gap', severity: 0.78, detail: null },
  ];
  const { total } = scoreSignals(signals);
  assert.ok(total >= 1.75, `expected >= 1.75 firing threshold, got ${total}`);
  assert.equal(Math.round(total * 100) / 100, 1.89);
});

test('scoreSignals: ghost override admits when ≥50% missing AND ≥3 absolute', () => {
  // Route 8 May 4: observed 2.5 of 5.1 expected, missing 2.6 → 51%.
  // Doesn't qualify because absolute < 3.
  const tooFewAbs = scoreSignals([
    {
      source: 'ghost',
      severity: 1.0,
      detail: JSON.stringify({ observed: 2.5, expected: 5.1, missing: 2.6 }),
    },
  ]);
  assert.equal(tooFewAbs.ghostOverride, false);

  // Route 66 May 7: 2.5 of 8.0 expected, missing 5.5 → 69%. Qualifies.
  const qualifies = scoreSignals([
    {
      source: 'ghost',
      severity: 1.0,
      detail: JSON.stringify({ observed: 2.5, expected: 8.0, missing: 5.5 }),
    },
  ]);
  assert.equal(qualifies.ghostOverride, true);

  // 40% missing with high absolute count: still doesn't qualify.
  const belowPct = scoreSignals([
    {
      source: 'ghost',
      severity: 1.0,
      detail: JSON.stringify({ observed: 6, expected: 10, missing: 4 }),
    },
  ]);
  assert.equal(belowPct.ghostOverride, false);
});

test('scoreSignals: ghost override only triggers on ghost source', () => {
  // A bunching signal with a "missing/expected" detail shouldn't qualify.
  const result = scoreSignals([
    {
      source: 'bunching',
      severity: 1.0,
      detail: JSON.stringify({ missing: 5, expected: 8 }),
    },
  ]);
  assert.equal(result.ghostOverride, false);
});

test('scoreSignals: malformed ghost detail fails closed', () => {
  const result = scoreSignals([{ source: 'ghost', severity: 1.0, detail: 'not-json' }]);
  assert.equal(result.ghostOverride, false);
});

test('train roundup text includes line name and signals', () => {
  const text = buildRoundupText({
    kind: 'train',
    line: 'red',
    signals: [
      { source: 'gap', severity: 0.7, detail: JSON.stringify({ ratio: 2.6, suppressed: 'cap' }) },
      { source: 'ghost', severity: 0.9, detail: JSON.stringify({ missing: 2.5, expected: 8.5 }) },
    ],
  });
  assert.ok(text.includes('Red'));
  assert.ok(text.includes('multiple signals'));
  assert.ok(text.includes('2.6x'));
  assert.ok(text.includes('trains missing'));
});

test('bus roundup text uses #route framing and "buses missing"', () => {
  const text = buildRoundupText({
    kind: 'bus',
    line: '147',
    name: 'Outer DuSable Lake Shore Express',
    signals: [
      { source: 'gap', severity: 0.7, detail: JSON.stringify({ ratio: 4.0, suppressed: 'cap' }) },
      {
        source: 'bunching',
        severity: 0.6,
        detail: JSON.stringify({ vehicles: 3, span_ft: 1040, suppressed: 'cap' }),
      },
      {
        source: 'pulse-held',
        severity: 1.0,
        detail: JSON.stringify({ route: '147', kind: 'held' }),
      },
    ],
  });
  assert.ok(text.includes('#147'));
  assert.ok(text.includes('Outer DuSable'));
  assert.ok(text.includes('buses recently bunched together'));
  assert.ok(text.includes('appear stuck in place') || text.includes('service gap forming'));
});

test('buildRoundupText: ghost dedup picks the worst direction, not first-seen', () => {
  // #151 Sheridan had NB at 5/8 (63%) and SB at 3/9 (31%); pre-fix the
  // roundup picked SB and underreported the actual story.
  const text = buildRoundupText({
    kind: 'bus',
    line: '151',
    name: 'Sheridan',
    signals: [
      // SB first in array — would have won the old "first-seen" dedup.
      { source: 'ghost', severity: 1.0, detail: JSON.stringify({ missing: 3, expected: 9 }) },
      { source: 'ghost', severity: 1.0, detail: JSON.stringify({ missing: 5, expected: 8 }) },
    ],
  });
  assert.ok(text.includes('5 of 8 buses missing'), `expected NB headline, got:\n${text}`);
  assert.ok(!text.includes('3 of 9'), `should not show the less-severe SB number, got:\n${text}`);
});

test('describeSignal handles unknown source gracefully', () => {
  const text = describeSignal({ source: 'unknown', severity: 0.5, detail: null }, 'train');
  assert.ok(text.includes('unknown'));
});

test('describeSignal: bunching reads as plain count', () => {
  const cd = describeSignal(
    {
      source: 'bunching',
      severity: 0.8,
      detail: JSON.stringify({ vehicles: 4, suppressed: 'cooldown' }),
    },
    'bus',
  );
  assert.equal(cd, '· 4 buses recently bunched together');

  const trainBunch = describeSignal(
    {
      source: 'bunching',
      severity: 0.8,
      detail: JSON.stringify({ vehicles: 3, suppressed: 'cap' }),
    },
    'train',
  );
  assert.equal(trainBunch, '· 3 trains recently bunched together');
});

test('describeSignal: gap ratio rounds to one decimal and names vehicle', () => {
  const text = describeSignal(
    {
      source: 'gap',
      severity: 0.6,
      detail: JSON.stringify({ ratio: 4.073404856013552, suppressed: 'cooldown' }),
    },
    'bus',
  );
  assert.ok(text.includes('one gap between buses is 4.1x the scheduled wait'));
  assert.ok(!text.includes('4.073'));
  assert.ok(!text.includes('('));

  const trainText = describeSignal(
    { source: 'gap', severity: 0.6, detail: JSON.stringify({ ratio: 3.2 }) },
    'train',
  );
  assert.ok(trainText.includes('one gap between trains is 3.2x the scheduled wait'));
});

test('describeSignal: gap names the flanking stretch when detail carries it', () => {
  const text = describeSignal(
    {
      source: 'gap',
      severity: 0.6,
      detail: JSON.stringify({ ratio: 3.1, fromStation: 'Howard', toStation: 'Jarvis' }),
    },
    'train',
  );
  assert.ok(
    text.includes('one gap between trains is 3.1x the scheduled wait, between Howard and Jarvis'),
  );
  // A detail missing one endpoint omits the stretch clause rather than printing
  // a dangling "between Howard and".
  const partial = describeSignal(
    { source: 'gap', severity: 0.6, detail: JSON.stringify({ ratio: 3.1, fromStation: 'Howard' }) },
    'train',
  );
  assert.ok(partial.endsWith('the scheduled wait'));
  assert.ok(!partial.includes('between Howard and'));
});

test('describeSignal: ghost missing/expected round to whole vehicles', () => {
  const text = describeSignal(
    { source: 'ghost', severity: 0.7, detail: JSON.stringify({ missing: 7.3, expected: 18.3 }) },
    'bus',
  );
  assert.ok(text.includes('7 of 18 buses missing this past hour'));
  assert.ok(!text.includes('.3'));
});

test('describeSignal: bus ghost says "buses" not "trains"', () => {
  const text = describeSignal(
    { source: 'ghost', severity: 0.9, detail: JSON.stringify({ missing: 4, expected: 12 }) },
    'bus',
  );
  assert.ok(text.includes('buses missing'));
});

test('buildResolutionText: bus uses 🚌✅ + #route framing', () => {
  const text = buildResolutionText({ kind: 'bus', line: '66', name: 'Chicago' });
  assert.ok(text.startsWith('🚌✅'));
  assert.ok(text.includes('#66 Chicago'));
  assert.ok(text.includes('back to normal'));
});

test('sweepResolutions: posts after MIN_CLEAR_TICKS consecutive sub-threshold ticks', async () => {
  const Path = require('node:path');
  const Fs = require('node:fs');
  const Os = require('node:os');
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-resolve-'));
  process.env.HISTORY_DB_PATH = Path.join(dir, 'history.sqlite');
  delete require.cache[require.resolve('../src/shared/history')];
  delete require.cache[require.resolve('../bin/incident-roundup')];
  const history = require('../src/shared/history');
  const { sweepResolutions: sweep } = require('../bin/incident-roundup');
  history.getDb();
  // Stub global fetch so the link-card path doesn't hit the real
  // chicagotransitalerts.app during tests. Returning !ok skips the
  // uploadBlob branch entirely; the post still goes out without a thumb.
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    headers: new Map(),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  try {
    const ROUNDUP_URI = 'at://did:plc:alerts/app.bsky.feed.post/roundup-1';
    history.recordRoundupAnchor({
      kind: 'bus',
      line: '66',
      postUri: ROUNDUP_URI,
      postCid: 'cid-1',
      ts: Date.now() - 10 * 60_000,
    });

    const posts = [];
    const agent = {
      session: { did: 'did:plc:test' },
      com: {
        atproto: {
          repo: {
            getRecord: async () => ({ data: { uri: ROUNDUP_URI, cid: 'cid-1', value: {} } }),
          },
        },
      },
      post: async (req) => {
        const r = { uri: 'at://did:plc:test/app.bsky.feed.post/resolve-1', cid: 'cid-r' };
        posts.push({ ...req, ...r });
        return r;
      },
    };
    const agentGetter = async () => agent;

    // No meta_signals at all → score=0 → clear ticks should accumulate.
    const now = Date.now();
    await sweep({ kind: 'bus', getName: () => 'Chicago', agentGetter, now });
    await sweep({ kind: 'bus', getName: () => 'Chicago', agentGetter, now: now + 60_000 });
    assert.equal(posts.length, 0, 'should not resolve before MIN_CLEAR_TICKS');

    await sweep({ kind: 'bus', getName: () => 'Chicago', agentGetter, now: now + 120_000 });
    assert.equal(posts.length, 1, 'should resolve on 3rd consecutive clear tick');
    assert.ok(posts[0].text.startsWith('🚌✅'));
    assert.equal(posts[0].reply.root.uri, ROUNDUP_URI);
    // The event link is carried by the embed card only — not duplicated in
    // the post text.
    assert.ok(
      !posts[0].text.includes('chicagotransitalerts.app'),
      `URL should not be in post text, got: ${posts[0].text}`,
    );
    assert.equal(posts[0].embed?.$type, 'app.bsky.embed.external');
    assert.equal(
      posts[0].embed?.external?.uri,
      'https://chicagotransitalerts.app/event/roundup-1/resolved',
    );

    // Subsequent sweeps shouldn't post again — resolved_ts is now set.
    await sweep({ kind: 'bus', getName: () => 'Chicago', agentGetter, now: now + 180_000 });
    assert.equal(posts.length, 1, 'resolved roundups are not swept again');
  } finally {
    global.fetch = originalFetch;
    try {
      history.getDb().close();
    } catch (_e) {}
    delete require.cache[require.resolve('../src/shared/history')];
    delete require.cache[require.resolve('../bin/incident-roundup')];
    delete process.env.HISTORY_DB_PATH;
    Fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepResolutions: elevated score resets clear_ticks counter', async () => {
  const Path = require('node:path');
  const Fs = require('node:fs');
  const Os = require('node:os');
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-resolve2-'));
  process.env.HISTORY_DB_PATH = Path.join(dir, 'history.sqlite');
  delete require.cache[require.resolve('../src/shared/history')];
  delete require.cache[require.resolve('../bin/incident-roundup')];
  const history = require('../src/shared/history');
  const { sweepResolutions: sweep } = require('../bin/incident-roundup');
  history.getDb();
  try {
    history.recordRoundupAnchor({
      kind: 'bus',
      line: '66',
      postUri: 'at://x/p/r',
      postCid: 'c',
      ts: Date.now(),
    });
    // Seed a fresh hot signal so score >= RESOLVE_SCORE_THRESHOLD (1.0).
    history.recordMetaSignal({
      kind: 'bus',
      line: '66',
      direction: null,
      source: 'gap',
      severity: 1.0,
      detail: { ratio: 4.0 },
      posted: true,
    });
    // Pre-set clear_ticks to 2 so we'd be one tick from resolving if quiet.
    history.getDb().prepare('UPDATE roundup_anchors SET clear_ticks = 2').run();

    const posts = [];
    const agent = {
      post: async () => {
        posts.push(1);
        return { uri: 'x', cid: 'y' };
      },
      com: {
        atproto: { repo: { getRecord: async () => ({ data: { uri: 'x', cid: 'y', value: {} } }) } },
      },
    };
    await sweep({
      kind: 'bus',
      getName: () => null,
      agentGetter: async () => agent,
      now: Date.now(),
    });
    assert.equal(posts.length, 0, 'elevated score must not resolve');
    const row = history.getDb().prepare('SELECT clear_ticks FROM roundup_anchors').get();
    assert.equal(row.clear_ticks, 0, 'clear_ticks resets when score elevated');
  } finally {
    try {
      history.getDb().close();
    } catch (_e) {}
    delete require.cache[require.resolve('../src/shared/history')];
    delete require.cache[require.resolve('../bin/incident-roundup')];
    delete process.env.HISTORY_DB_PATH;
    Fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildResolutionText: train uses 🚇✅ + Line framing', () => {
  const text = buildResolutionText({ kind: 'train', line: 'red', name: null });
  assert.ok(text.startsWith('🚇✅'));
  assert.ok(text.includes('Red Line'));
  assert.ok(text.includes('back to normal'));
});
