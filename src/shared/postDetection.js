const { acquireCooldown } = require('./state');

// Returns { agent, primary } on post, null on cooldown-race loss.
async function commitAndPost({
  cooldownKeys, cooldownTtlMs, recordSkip, agentLogin, image, text, alt, recordPosted,
  postWithImage, postText,
}) {
  if (!acquireCooldown(cooldownKeys, Date.now(), cooldownTtlMs || null)) {
    console.log('Lost cooldown race to another instance, skipping post');
    recordSkip();
    return null;
  }
  const agent = await agentLogin();
  const primary = image
    ? await postWithImage(agent, text, image, alt)
    : await postText(agent, text);
  recordPosted(primary);
  console.log(`Posted: ${primary.url}`);
  return { agent, primary };
}

module.exports = { commitAndPost };
