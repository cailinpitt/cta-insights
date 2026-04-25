const { AtpAgent } = require('@atproto/api');

async function login(identifier, password) {
  const agent = new AtpAgent({ service: process.env.BLUESKY_SERVICE || 'https://bsky.social' });
  await agent.login({ identifier, password });
  return agent;
}

function postUrl(result) {
  const rkey = result.uri.split('/').pop();
  const did = result.uri.split('/')[2];
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

async function postWithImage(agent, text, imageBuffer, altText, replyRef = null) {
  const upload = await agent.uploadBlob(imageBuffer, { encoding: 'image/jpeg' });
  const result = await agent.post({
    text,
    ...(replyRef && { reply: replyRef }),
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{ image: upload.data.blob, alt: altText }],
    },
  });
  return { url: postUrl(result), uri: result.uri, cid: result.cid };
}

const VIDEO_SERVICE = 'https://video.bsky.app';
const MAX_POLL_ATTEMPTS = 150; // 5 min @ 2s intervals

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Upload an MP4 and create a post embedding it. Mirrors the ClassicTraffic
 * upload flow: request a service auth token, POST to video.bsky.app, poll
 * getJobStatus until the blob is ready, then embed it on a post.
 */
async function postWithVideo(agent, text, videoBuffer, altText, replyRef = null) {
  const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${agent.dispatchUrl.host}`,
    lxm: 'com.atproto.repo.uploadBlob',
    exp: Math.floor(Date.now() / 1000) + 60 * 30,
  });
  const token = serviceAuth.token;

  const uploadUrl = new URL(`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`);
  uploadUrl.searchParams.append('did', agent.session.did);
  uploadUrl.searchParams.append('name', 'bunching.mp4');

  let uploadResponse;
  for (let attempt = 1; attempt <= 3; attempt++) {
    uploadResponse = await fetch(uploadUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'video/mp4',
        'Content-Length': videoBuffer.length.toString(),
      },
      body: videoBuffer,
    });
    if (uploadResponse.ok) break;
    const errBody = await uploadResponse.json().catch(() => ({}));
    if (attempt >= 3) throw new Error(`Video upload failed after 3 attempts: ${JSON.stringify(errBody)}`);
    await sleep(1000 * attempt);
  }

  const jobStatus = await uploadResponse.json();
  let blob = jobStatus.blob;
  const videoServiceAgent = new AtpAgent({ service: VIDEO_SERVICE });
  let lastLogged = null;
  let polls = 0;

  while (!blob) {
    if (++polls > MAX_POLL_ATTEMPTS) throw new Error('Video processing timed out');
    await sleep(2000);
    try {
      const { data: status } = await videoServiceAgent.app.bsky.video.getJobStatus({ jobId: jobStatus.jobId });
      const state = status.jobStatus.state;
      const progress = status.jobStatus.progress;
      const label = progress ? `${state}: ${progress}%` : state;
      if (label !== lastLogged) {
        console.log(`video processing: ${label}`);
        lastLogged = label;
      }
      if (status.jobStatus.blob) blob = status.jobStatus.blob;
      else if (state === 'JOB_STATE_FAILED') throw new Error(`Video processing failed: ${status.jobStatus.error || 'unknown'}`);
    } catch (e) {
      if (e.message && e.message.includes('already_exists')) { blob = e.blob || jobStatus.blob; break; }
      throw e;
    }
  }

  const result = await agent.post({
    text,
    ...(replyRef && { reply: replyRef }),
    embed: {
      $type: 'app.bsky.embed.video',
      video: blob,
      alt: altText,
    },
  });
  return { url: postUrl(result), uri: result.uri, cid: result.cid };
}

async function postText(agent, text, replyRef = null) {
  const result = await agent.post({
    text,
    ...(replyRef && { reply: replyRef }),
  });
  return { url: postUrl(result), uri: result.uri, cid: result.cid };
}

// Login helper for the dedicated alerts/disruptions account. Used by
// bin/{bus,train}/alerts.js (CTA-sourced alerts) and bin/train/pulse.js
// (auto-detected service disruptions). Kept separate from the analytics-
// focused bus/train accounts so followers can opt into one stream or the
// other.
function loginAlerts() {
  return login(process.env.BLUESKY_ALERTS_IDENTIFIER, process.env.BLUESKY_ALERTS_APP_PASSWORD);
}

// Build a reply ref pointing at `parentUri`. Inherits the parent's `root`
// when the parent is itself a reply, so the new post lands in the same thread
// rather than starting a sub-thread.
async function resolveReplyRef(agent, parentUri) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(parentUri);
  if (!m) return null;
  const [, repo, collection, rkey] = m;
  try {
    const { data: record } = await agent.com.atproto.repo.getRecord({ repo, collection, rkey });
    const parent = { uri: parentUri, cid: record.cid };
    const root = record.value && record.value.reply && record.value.reply.root
      ? record.value.reply.root
      : parent;
    return { root, parent };
  } catch (_) {
    return null;
  }
}

module.exports = { login, loginAlerts, postWithImage, postWithVideo, postText, resolveReplyRef };
