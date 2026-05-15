const test = require('node:test');
const assert = require('node:assert');
const { rkeyFromAtUri, resolvedEventLink } = require('../../src/shared/eventLink');

test('rkeyFromAtUri extracts the trailing rkey from an AT URI', () => {
  assert.equal(
    rkeyFromAtUri('at://did:plc:jgg4dtdflzzemyvnybucnzdw/app.bsky.feed.post/3mlrlx6cx3j2i'),
    '3mlrlx6cx3j2i',
  );
});

test('rkeyFromAtUri returns null for missing or malformed input', () => {
  assert.equal(rkeyFromAtUri(null), null);
  assert.equal(rkeyFromAtUri(''), null);
  assert.equal(rkeyFromAtUri('garbage'), null);
  assert.equal(rkeyFromAtUri('at://did/short'), null);
});

test('resolvedEventLink builds /event/<rkey>/resolved with og thumb', () => {
  const link = resolvedEventLink('at://did:plc:abc/app.bsky.feed.post/3xyz', 'some post text');
  assert.equal(link.url, 'https://chicagotransitalerts.app/event/3xyz/resolved');
  assert.equal(link.title, 'some post text');
  assert.equal(link.thumbUrl, 'https://chicagotransitalerts.app/event/3xyz/resolved/og.png');
  assert.equal(link.description, 'View this incident on the Chicago Transit Alerts archive.');
});

test('resolvedEventLink returns null when rkey cannot be extracted', () => {
  assert.equal(resolvedEventLink(null), null);
  assert.equal(resolvedEventLink(''), null);
});
