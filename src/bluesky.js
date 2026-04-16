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

async function postWithImage(agent, text, imageBuffer, altText) {
  const upload = await agent.uploadBlob(imageBuffer, { encoding: 'image/jpeg' });
  const result = await agent.post({
    text,
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{ image: upload.data.blob, alt: altText }],
    },
  });
  const rkey = result.uri.split('/').pop();
  const did = result.uri.split('/')[2];
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

module.exports = { loginBus, loginTrain, postWithImage };
