const test = require('node:test');
const assert = require('node:assert/strict');

const { postQuote, getPostRecord, resolveReplyRef } = require('../../src/shared/bluesky');

function makeAgent({ getRecord, post } = {}) {
  const calls = { getRecord: [], post: [] };
  return {
    calls,
    com: {
      atproto: {
        repo: {
          getRecord: async (params) => {
            calls.getRecord.push(params);
            if (typeof getRecord === 'function') return getRecord(params);
            throw new Error('getRecord not stubbed');
          },
        },
      },
    },
    post: async (params) => {
      calls.post.push(params);
      if (typeof post === 'function') return post(params);
      return {
        uri: 'at://did:plc:author/app.bsky.feed.post/newrkey',
        cid: 'bafy-new',
      };
    },
  };
}

test('postQuote builds correct embed and returns expected shape', async () => {
  const agent = makeAgent();
  const quoted = { uri: 'at://did:plc:other/app.bsky.feed.post/qrkey', cid: 'bafy-quoted' };
  const result = await postQuote(agent, 'hello world', quoted);

  assert.equal(agent.calls.post.length, 1);
  const sent = agent.calls.post[0];
  assert.equal(sent.text, 'hello world');
  assert.equal(sent.reply, undefined);
  assert.deepEqual(sent.embed, {
    $type: 'app.bsky.embed.record',
    record: { uri: quoted.uri, cid: quoted.cid },
  });
  assert.deepEqual(result, {
    url: 'https://bsky.app/profile/did:plc:author/post/newrkey',
    uri: 'at://did:plc:author/app.bsky.feed.post/newrkey',
    cid: 'bafy-new',
  });
});

test('postQuote threads under replyRef when provided', async () => {
  const agent = makeAgent();
  const quoted = { uri: 'at://did:plc:other/app.bsky.feed.post/qrkey', cid: 'bafy-quoted' };
  const replyRef = {
    root: { uri: 'at://did:plc:r/app.bsky.feed.post/root', cid: 'bafy-root' },
    parent: { uri: 'at://did:plc:r/app.bsky.feed.post/par', cid: 'bafy-par' },
  };
  await postQuote(agent, 'reply text', quoted, replyRef);
  const sent = agent.calls.post[0];
  assert.deepEqual(sent.reply, replyRef);
  assert.equal(sent.embed.$type, 'app.bsky.embed.record');
});

test('getPostRecord returns record with replyRoot=self for top-level posts', async () => {
  const uri = 'at://did:plc:author/app.bsky.feed.post/abc';
  const agent = makeAgent({
    getRecord: async () => ({ data: { cid: 'bafy-top', value: { text: 'hi' } } }),
  });
  const out = await getPostRecord(agent, uri);
  assert.deepEqual(agent.calls.getRecord[0], {
    repo: 'did:plc:author',
    collection: 'app.bsky.feed.post',
    rkey: 'abc',
  });
  assert.deepEqual(out, {
    uri,
    cid: 'bafy-top',
    value: { text: 'hi' },
    replyRoot: { uri, cid: 'bafy-top' },
  });
});

test('getPostRecord returns replyRoot from value.reply.root for replies', async () => {
  const uri = 'at://did:plc:author/app.bsky.feed.post/reply1';
  const root = { uri: 'at://did:plc:other/app.bsky.feed.post/root1', cid: 'bafy-root' };
  const value = { text: 'a reply', reply: { root, parent: { uri: 'x', cid: 'y' } } };
  const agent = makeAgent({
    getRecord: async () => ({ data: { cid: 'bafy-reply', value } }),
  });
  const out = await getPostRecord(agent, uri);
  assert.deepEqual(out.replyRoot, root);
  assert.equal(out.cid, 'bafy-reply');
  assert.equal(out.value, value);
});

test('getPostRecord returns null on malformed URI', async () => {
  const agent = makeAgent();
  assert.equal(await getPostRecord(agent, 'not-a-uri'), null);
  assert.equal(await getPostRecord(agent, 'https://example.com'), null);
  assert.equal(agent.calls.getRecord.length, 0);
});

test('getPostRecord returns null when getRecord throws', async () => {
  const agent = makeAgent({
    getRecord: async () => {
      throw new Error('nope');
    },
  });
  const out = await getPostRecord(agent, 'at://did:plc:a/app.bsky.feed.post/x');
  assert.equal(out, null);
});

test('resolveReplyRef returns {root, parent} for top-level parent (regression)', async () => {
  const uri = 'at://did:plc:author/app.bsky.feed.post/top';
  const agent = makeAgent({
    getRecord: async () => ({ data: { cid: 'bafy-top', value: { text: 'hi' } } }),
  });
  const ref = await resolveReplyRef(agent, uri);
  assert.deepEqual(ref, {
    root: { uri, cid: 'bafy-top' },
    parent: { uri, cid: 'bafy-top' },
  });
});

test('resolveReplyRef inherits root when parent is itself a reply', async () => {
  const uri = 'at://did:plc:author/app.bsky.feed.post/midreply';
  const root = { uri: 'at://did:plc:other/app.bsky.feed.post/origroot', cid: 'bafy-orig' };
  const agent = makeAgent({
    getRecord: async () => ({
      data: { cid: 'bafy-mid', value: { reply: { root, parent: { uri: 'p', cid: 'pc' } } } },
    }),
  });
  const ref = await resolveReplyRef(agent, uri);
  assert.deepEqual(ref, {
    root,
    parent: { uri, cid: 'bafy-mid' },
  });
});

test('resolveReplyRef returns null on bad URI', async () => {
  const agent = makeAgent();
  assert.equal(await resolveReplyRef(agent, 'garbage'), null);
});
