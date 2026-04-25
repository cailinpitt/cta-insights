const { acquireCooldown } = require('./state');

// Final atomic acquire + post + record dance shared by bus/train bunching
// and gap detectors. The candidate-selection loop differs by detector and
// stays in each bin script; this helper covers the bit that's identical.
//
// On cooldown-race loss: calls recordSkip and returns null. On success:
// returns { agent, primary } so the caller can attach a video reply.
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
