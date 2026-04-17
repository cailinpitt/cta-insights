const { AtpAgent } = require('@atproto/api');

async function loginBus() {
  const agent = new AtpAgent({ service: process.env.BLUESKY_SERVICE || 'https://bsky.social' });
  await agent.login({
    identifier: process.env.BLUESKY_BUS_IDENTIFIER,
    password: process.env.BLUESKY_BUS_APP_PASSWORD,
  });
  return agent;
}

async function loginTrain() {
  const agent = new AtpAgent({ service: process.env.BLUESKY_SERVICE || 'https://bsky.social' });
  await agent.login({
    identifier: process.env.BLUESKY_TRAIN_IDENTIFIER,
    password: process.env.BLUESKY_TRAIN_APP_PASSWORD,
  });
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

module.exports = { loginBus, loginTrain, postWithImage, postWithVideo };
