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
