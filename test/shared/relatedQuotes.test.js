const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function loadWithFreshDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-quotes-sweep-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  delete require.cache[require.resolve('../../src/shared/relatedQuotes')];
  delete require.cache[require.resolve('../../src/shared/bluesky')];
  delete require.cache[require.resolve('../../src/shared/trainSegment')];
  delete require.cache[require.resolve('../../src/bus/patterns')];
  const history = require('../../src/shared/history');
  const sweepMod = require('../../src/shared/relatedQuotes');
  history.getDb();
  return {
    history,
    sweepMod,
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_e) {}
      delete require.cache[require.resolve('../../src/shared/history')];
      delete require.cache[require.resolve('../../src/shared/relatedQuotes')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {}
    },
  };
}

// Mock agent that fakes getRecord and post. Records every post call so tests
// can introspect what was sent.
function buildMockAgent({ records = {}, postsResult = {} } = {}) {
  const posts = [];
  let postCounter = 0;
  return {
    posts,
    com: {
      atproto: {
        repo: {
          getRecord: async ({ repo, collection, rkey }) => {
            const uri = `at://${repo}/${collection}/${rkey}`;
            const r = records[uri];
            if (!r) {
              const err = new Error(`not found: ${uri}`);
              err.uri = uri;
              throw err;
            }
            return { data: { uri, cid: r.cid, value: r.value || {} } };
          },
        },
      },
    },
    post: async (req) => {
      const id = ++postCounter;
      const uri = `at://did:plc:test/app.bsky.feed.post/quote-${id}`;
      const cid = `cid-quote-${id}`;
      posts.push({ uri, cid, ...req });
      return { uri, cid, ...postsResult };
    },
  };
}

const TRAIN_ALERT_URI = 'at://did:plc:test/app.bsky.feed.post/alert-1';
const TRAIN_ALERT_CID = 'cid-alert-1';
const BUNCHING_RED_WILSON = 'at://did:plc:bus/app.bsky.feed.post/bunching-1';
const BUNCHING_RED_95TH = 'at://did:plc:bus/app.bsky.feed.post/bunching-95th';
const BUNCHING_RED_WILSON_CID = 'cid-bunching-wilson';
const BUNCHING_RED_95TH_CID = 'cid-bunching-95th';

function seedTrainAlert(history, { from, to, direction = null }) {
  history.recordAlertSeen({
    alertId: 'A1',
    kind: 'train',
    routes: 'red',
    headline: `Red Line: trains running between ${from} and ${to}`,
    postUri: TRAIN_ALERT_URI,
    affectedFromStation: from,
    affectedToStation: to,
    affectedDirection: direction,
  });
}

function seedBunching(history, { route, near_stop, post_uri, ts, direction = null }) {
  history
    .getDb()
    .prepare(`
      INSERT INTO bunching_events
        (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
      VALUES (?, 'train', ?, ?, ?, ?, ?, 1, ?)
    `)
    .run(ts, route, direction, 2, 1500, near_stop, post_uri);
}

test('bus: roundup anchor quote-attaches a route-matching bunching post (no segment needed)', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    const ROUNDUP_URI = 'at://did:plc:alerts/app.bsky.feed.post/roundup-66';
    const ROUNDUP_CID = 'cid-roundup-66';
    const BUS_BUNCH_URI = 'at://did:plc:bus/app.bsky.feed.post/bunch-66';
    const BUS_BUNCH_CID = 'cid-bunch-66';
    const now = Date.now();
    history.recordRoundupAnchor({
      kind: 'bus',
      line: '66',
      postUri: ROUNDUP_URI,
      postCid: ROUNDUP_CID,
      ts: now - 27 * 60 * 1000,
    });
    history
      .getDb()
      .prepare(`
        INSERT INTO bunching_events
          (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
        VALUES (?, 'bus', '66', 'pid-x', 7, 1584, 'Grand & Union', 1, ?)
      `)
      .run(now, BUS_BUNCH_URI);
    const agent = buildMockAgent({
      records: {
        [ROUNDUP_URI]: { cid: ROUNDUP_CID, value: {} },
        [BUS_BUNCH_URI]: { cid: BUS_BUNCH_CID, value: {} },
      },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'bus', agent, now });
    assert.equal(out.posted, 1, 'bunching post should attach to roundup');
    assert.equal(agent.posts[0].embed.record.uri, BUS_BUNCH_URI);
    assert.equal(agent.posts[0].reply.root.uri, ROUNDUP_URI);
  } finally {
    cleanup();
  }
});

test('bus: roundup anchor does NOT attach a different-route bunching post', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    const ROUNDUP_URI = 'at://did:plc:alerts/app.bsky.feed.post/roundup-66';
    history.recordRoundupAnchor({
      kind: 'bus',
      line: '66',
      postUri: ROUNDUP_URI,
      postCid: 'cid-roundup-66',
      ts: Date.now(),
    });
    history
      .getDb()
      .prepare(`
        INSERT INTO bunching_events
          (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
        VALUES (?, 'bus', '49', 'pid-x', 5, 2000, 'Belmont', 1, ?)
      `)
      .run(Date.now(), 'at://did:plc:bus/app.bsky.feed.post/bunch-49');
    const agent = buildMockAgent({
      records: { [ROUNDUP_URI]: { cid: 'cid-roundup-66', value: {} } },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'bus', agent });
    assert.equal(out.posted, 0);
  } finally {
    cleanup();
  }
});

test('bus: expired roundup anchor is skipped', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    const ROUNDUP_URI = 'at://did:plc:alerts/app.bsky.feed.post/roundup-old';
    const now = Date.now();
    history.recordRoundupAnchor({
      kind: 'bus',
      line: '66',
      postUri: ROUNDUP_URI,
      postCid: 'cid-old',
      ts: now - 3 * 60 * 60 * 1000, // 3h ago
      ttlMs: 2 * 60 * 60 * 1000, // expires after 2h
    });
    history
      .getDb()
      .prepare(`
        INSERT INTO bunching_events
          (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
        VALUES (?, 'bus', '66', 'pid-x', 7, 1584, 'Grand & Union', 1, ?)
      `)
      .run(now, 'at://did:plc:bus/app.bsky.feed.post/bunch-66-late');
    const agent = buildMockAgent({ records: {} });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'bus', agent, now });
    assert.equal(out.posted, 0);
    assert.equal(out.groups, 0);
  } finally {
    cleanup();
  }
});

test('train: candidate inside segment is quoted; candidate outside segment is not', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    seedTrainAlert(history, { from: 'Belmont', to: 'Howard' });
    const ts = Date.now();
    seedBunching(history, {
      route: 'red',
      near_stop: 'Wilson',
      post_uri: BUNCHING_RED_WILSON,
      ts,
    });
    seedBunching(history, {
      route: 'red',
      near_stop: '95th/Dan Ryan',
      post_uri: BUNCHING_RED_95TH,
      ts,
    });
    const agent = buildMockAgent({
      records: {
        [TRAIN_ALERT_URI]: { cid: TRAIN_ALERT_CID, value: {} },
        [BUNCHING_RED_WILSON]: { cid: BUNCHING_RED_WILSON_CID, value: {} },
        [BUNCHING_RED_95TH]: { cid: BUNCHING_RED_95TH_CID, value: {} },
      },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out.posted, 1);
    assert.equal(agent.posts.length, 1);
    const sent = agent.posts[0];
    assert.equal(sent.embed.$type, 'app.bsky.embed.record');
    assert.equal(sent.embed.record.uri, BUNCHING_RED_WILSON);
    assert.equal(sent.text, 'Related observation:');
    // Reply ref roots on the alert post.
    assert.equal(sent.reply.root.uri, TRAIN_ALERT_URI);
  } finally {
    cleanup();
  }
});

test('train: idempotent — second sweep does not re-quote', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    seedTrainAlert(history, { from: 'Belmont', to: 'Howard' });
    seedBunching(history, {
      route: 'red',
      near_stop: 'Wilson',
      post_uri: BUNCHING_RED_WILSON,
      ts: Date.now(),
    });
    const agent = buildMockAgent({
      records: {
        [TRAIN_ALERT_URI]: { cid: TRAIN_ALERT_CID, value: {} },
        [BUNCHING_RED_WILSON]: { cid: BUNCHING_RED_WILSON_CID, value: {} },
      },
    });
    await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    const second = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(second.posted, 0);
    assert.equal(agent.posts.length, 1);
  } finally {
    cleanup();
  }
});

test('train: cap of 3 per thread', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    seedTrainAlert(history, { from: 'Belmont', to: 'Howard' });
    const ts = Date.now();
    const stations = ['Wilson', 'Lawrence', 'Argyle', 'Berwyn', 'Bryn Mawr'];
    const records = {
      [TRAIN_ALERT_URI]: { cid: TRAIN_ALERT_CID, value: {} },
    };
    for (let i = 0; i < stations.length; i++) {
      const uri = `at://did:plc:bus/app.bsky.feed.post/bunch-${i}`;
      seedBunching(history, {
        route: 'red',
        near_stop: stations[i],
        post_uri: uri,
        ts: ts - i * 1000,
      });
      records[uri] = { cid: `cid-${i}`, value: {} };
    }
    const agent = buildMockAgent({ records });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out.posted, 3, 'should cap at 3 quotes');
    assert.equal(agent.posts.length, 3);
  } finally {
    cleanup();
  }
});

test('train: dryRun does not post or write', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    seedTrainAlert(history, { from: 'Belmont', to: 'Howard' });
    seedBunching(history, {
      route: 'red',
      near_stop: 'Wilson',
      post_uri: BUNCHING_RED_WILSON,
      ts: Date.now(),
    });
    const agent = buildMockAgent({
      records: {
        [TRAIN_ALERT_URI]: { cid: TRAIN_ALERT_CID, value: {} },
        [BUNCHING_RED_WILSON]: { cid: BUNCHING_RED_WILSON_CID, value: {} },
      },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent, dryRun: true });
    assert.equal(out.posted, 1);
    assert.equal(agent.posts.length, 0, 'no post in dry-run');
    const quoted = history.getThreadQuotedSourceUris(TRAIN_ALERT_URI);
    assert.equal(quoted.size, 0, 'no DB write in dry-run');
  } finally {
    cleanup();
  }
});

test('alert without segment info → no quotes attempted', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    history.recordAlertSeen({
      alertId: 'A2',
      kind: 'train',
      routes: 'red',
      headline: 'something happened',
      postUri: TRAIN_ALERT_URI,
      // no affected_* fields
    });
    seedBunching(history, {
      route: 'red',
      near_stop: 'Wilson',
      post_uri: BUNCHING_RED_WILSON,
      ts: Date.now(),
    });
    const agent = buildMockAgent({
      records: {
        [TRAIN_ALERT_URI]: { cid: TRAIN_ALERT_CID, value: {} },
        [BUNCHING_RED_WILSON]: { cid: BUNCHING_RED_WILSON_CID, value: {} },
      },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out.posted, 0);
    assert.equal(agent.posts.length, 0);
  } finally {
    cleanup();
  }
});

test('disabled via QUOTE_RELATED_POSTS=0 → no work', async () => {
  process.env.QUOTE_RELATED_POSTS = '0';
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    seedTrainAlert(history, { from: 'Belmont', to: 'Howard' });
    seedBunching(history, {
      route: 'red',
      near_stop: 'Wilson',
      post_uri: BUNCHING_RED_WILSON,
      ts: Date.now(),
    });
    const agent = buildMockAgent({});
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out.posted, 0);
    assert.equal(agent.posts.length, 0);
  } finally {
    delete process.env.QUOTE_RELATED_POSTS;
    cleanup();
  }
});

test('observation pulse anchor groups under same root as CTA alert reply', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    // Train pulse posted first; CTA alert threaded under it.
    const PULSE_URI = 'at://did:plc:test/app.bsky.feed.post/pulse-1';
    const PULSE_CID = 'cid-pulse-1';
    history.upsertPulseState({
      line: 'red',
      direction: 'north',
      runLoFt: 0,
      runHiFt: 5000,
      fromStation: 'Belmont',
      toStation: 'Howard',
      startedTs: Date.now() - 600000,
      lastSeenTs: Date.now(),
      consecutiveTicks: 2,
      clearTicks: 0,
      postedCooldownKey: 'k',
      activePostUri: PULSE_URI,
      activePostTs: Date.now() - 600000,
    });
    history.recordAlertSeen({
      alertId: 'A3',
      kind: 'train',
      routes: 'red',
      headline: 'Red Line between Belmont and Howard',
      postUri: TRAIN_ALERT_URI,
      affectedFromStation: 'Belmont',
      affectedToStation: 'Howard',
      affectedDirection: null,
    });
    seedBunching(history, {
      route: 'red',
      near_stop: 'Wilson',
      post_uri: BUNCHING_RED_WILSON,
      ts: Date.now(),
    });
    const agent = buildMockAgent({
      records: {
        [PULSE_URI]: { cid: PULSE_CID, value: {} }, // top-level
        [TRAIN_ALERT_URI]: {
          cid: TRAIN_ALERT_CID,
          value: { reply: { root: { uri: PULSE_URI, cid: PULSE_CID } } },
        },
        [BUNCHING_RED_WILSON]: { cid: BUNCHING_RED_WILSON_CID, value: {} },
      },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    // Two anchors → one group → one quote (cap not hit, only one candidate).
    assert.equal(out.groups, 1, 'should merge into single thread group');
    assert.equal(out.posted, 1);
    const sent = agent.posts[0];
    assert.equal(sent.reply.root.uri, PULSE_URI, 'reply roots on pulse, not alert');
  } finally {
    cleanup();
  }
});

test('train: NB alert + SB candidate at in-segment station → reject', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    // Red NB alert; bunching tagged trDr=5 (south on Red).
    history.recordAlertSeen({
      alertId: 'A-NB',
      kind: 'train',
      routes: 'red',
      headline: 'Red Line: northbound trains running between Belmont and Howard',
      postUri: TRAIN_ALERT_URI,
      affectedFromStation: 'Belmont',
      affectedToStation: 'Howard',
      affectedDirection: 'north',
    });
    history
      .getDb()
      .prepare(`
        INSERT INTO bunching_events
          (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
        VALUES (?, 'train', 'red', '5', 2, 1500, 'Wilson', 1, ?)
      `)
      .run(Date.now(), BUNCHING_RED_WILSON);
    const agent = buildMockAgent({
      records: {
        [TRAIN_ALERT_URI]: { cid: TRAIN_ALERT_CID, value: {} },
        [BUNCHING_RED_WILSON]: { cid: BUNCHING_RED_WILSON_CID, value: {} },
      },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out.posted, 0, 'opposite-direction candidate must be rejected');
  } finally {
    cleanup();
  }
});

test('train: NB alert + NB candidate (matching trDr) → accept', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    history.recordAlertSeen({
      alertId: 'A-NB2',
      kind: 'train',
      routes: 'red',
      headline: 'Red Line: northbound trains running between Belmont and Howard',
      postUri: TRAIN_ALERT_URI,
      affectedFromStation: 'Belmont',
      affectedToStation: 'Howard',
      affectedDirection: 'north',
    });
    // trDr=1 = north on Red.
    history
      .getDb()
      .prepare(`
        INSERT INTO bunching_events
          (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
        VALUES (?, 'train', 'red', '1', 2, 1500, 'Wilson', 1, ?)
      `)
      .run(Date.now(), BUNCHING_RED_WILSON);
    const agent = buildMockAgent({
      records: {
        [TRAIN_ALERT_URI]: { cid: TRAIN_ALERT_CID, value: {} },
        [BUNCHING_RED_WILSON]: { cid: BUNCHING_RED_WILSON_CID, value: {} },
      },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out.posted, 1);
  } finally {
    cleanup();
  }
});

test('train: pulse anchor branch-N-outbound carries through normalization', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    const PULSE_URI = 'at://did:plc:test/app.bsky.feed.post/pulse-brn';
    const PULSE_CID = 'cid-pulse-brn';
    history.upsertPulseState({
      line: 'brn',
      direction: 'branch-0-outbound',
      runLoFt: 0,
      runHiFt: 5000,
      fromStation: 'Belmont',
      toStation: 'Kimball',
      startedTs: Date.now() - 600000,
      lastSeenTs: Date.now(),
      consecutiveTicks: 2,
      clearTicks: 0,
      postedCooldownKey: 'k',
      activePostUri: PULSE_URI,
      activePostTs: Date.now() - 600000,
    });
    // brn outbound = trDr=1. Inbound bunching (trDr=5) should be rejected.
    history
      .getDb()
      .prepare(`
        INSERT INTO bunching_events
          (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
        VALUES (?, 'train', 'brn', '5', 2, 1500, 'Belmont', 1, ?)
      `)
      .run(Date.now(), BUNCHING_RED_WILSON);
    const agent = buildMockAgent({
      records: {
        [PULSE_URI]: { cid: PULSE_CID, value: {} },
        [BUNCHING_RED_WILSON]: { cid: BUNCHING_RED_WILSON_CID, value: {} },
      },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out.posted, 0, 'opposite-direction candidate rejected even with pulse anchor');
  } finally {
    cleanup();
  }
});

test('bus held→blackout transition: blackout no longer anchors as held cluster', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    const PULSE_URI = 'at://did:plc:test/app.bsky.feed.post/bus-pulse-1';
    const PULSE_CID = 'cid-bus-pulse';
    // Tick 1: held cluster persisted with pid + segment.
    history.upsertBusPulseState({
      route: '62',
      startedTs: Date.now() - 600000,
      lastSeenTs: Date.now() - 600000,
      consecutiveTicks: 1,
      clearTicks: 0,
      postedCooldownKey: 'k',
      affectedPid: '7120',
      affectedLoFt: 30000,
      affectedHiFt: 31000,
    });
    let anchors = history.listActiveBusPulseAnchors();
    assert.equal(anchors.length, 0, 'no active_post_uri yet');
    // Tick 2: blackout — affected_* go to null. Pulse posts (active_post_uri set).
    history.upsertBusPulseState({
      route: '62',
      startedTs: Date.now() - 600000,
      lastSeenTs: Date.now(),
      consecutiveTicks: 2,
      clearTicks: 0,
      postedCooldownKey: 'k',
      activePostUri: PULSE_URI,
      activePostTs: Date.now(),
      affectedPid: null,
      affectedLoFt: null,
      affectedHiFt: null,
    });
    anchors = history.listActiveBusPulseAnchors();
    assert.equal(
      anchors.length,
      0,
      'blackout (no segment) must NOT show up as a held-cluster anchor',
    );
  } finally {
    cleanup();
  }
});

test('bus held cluster: candidate on different route NOT matched even if pid string equal', async () => {
  // Defensive — pids are globally unique today, but the held loop should
  // also enforce route equality so a future pid-collision can't false-match.
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    const PULSE_URI = 'at://did:plc:test/app.bsky.feed.post/bus-pulse-r62';
    history.upsertBusPulseState({
      route: '62',
      startedTs: Date.now() - 600000,
      lastSeenTs: Date.now(),
      consecutiveTicks: 2,
      clearTicks: 0,
      postedCooldownKey: 'k',
      activePostUri: PULSE_URI,
      activePostTs: Date.now(),
      affectedPid: 'shared-pid',
      affectedLoFt: 0,
      affectedHiFt: 100000,
    });
    // Bunching event on a DIFFERENT route but somehow same pid — must not match.
    history
      .getDb()
      .prepare(`
        INSERT INTO bunching_events
          (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri)
        VALUES (?, 'bus', '49', 'shared-pid', 3, 1500, 'Belmont', 1, ?)
      `)
      .run(Date.now(), 'at://did:plc:bus/app.bsky.feed.post/bunch-49');
    // Route '49' isn't in the anchor's routes, so findRelatedAnalyticsPosts
    // won't return it in the first place — relevance filter never sees it.
    // Verify the relevance fn directly with a forged candidate to confirm
    // route is enforced.
    const cand = {
      source: 'bunching',
      route: '49',
      direction: 'shared-pid',
      near_stop: 'Belmont',
      post_uri: 'at://x',
      ts: Date.now(),
    };
    const group = {
      busHeldSegments: [{ route: '62', pid: 'shared-pid', loFt: 0, hiFt: 100000 }],
      busAlertSegments: [],
    };
    const ok = await sweepMod.busCandidateRelevant(
      cand,
      group,
      () => [],
      async () => null,
    );
    assert.equal(ok, false, 'route mismatch must reject even when pid equals');
  } finally {
    cleanup();
  }
});

test('candidate with deleted source post → tombstone, not retried', async () => {
  const { history, sweepMod, cleanup } = loadWithFreshDb();
  try {
    seedTrainAlert(history, { from: 'Belmont', to: 'Howard' });
    seedBunching(history, {
      route: 'red',
      near_stop: 'Wilson',
      post_uri: BUNCHING_RED_WILSON,
      ts: Date.now(),
    });
    // Alert post resolves; bunching post does not.
    const agent = buildMockAgent({
      records: { [TRAIN_ALERT_URI]: { cid: TRAIN_ALERT_CID, value: {} } },
    });
    const out = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out.posted, 0);
    const quoted = history.getThreadQuotedSourceUris(TRAIN_ALERT_URI);
    assert.ok(quoted.has(BUNCHING_RED_WILSON), 'tombstone recorded');
    // Second pass: should not even try to fetch the source again (excluded).
    const out2 = await sweepMod.sweepRelatedQuotes({ kind: 'train', agent });
    assert.equal(out2.posted, 0);
  } finally {
    cleanup();
  }
});
