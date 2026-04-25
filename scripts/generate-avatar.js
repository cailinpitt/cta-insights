#!/usr/bin/env node
// Twemoji SVGs are downloaded so the emoji renders identically regardless of
// host font — macOS and Ubuntu glyphs differ and we want dev/prod parity.
//
// Usage: node scripts/generate-avatar.js [--kind=bus|train|alerts]

const Fs = require('fs-extra');
const Path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const argv = require('minimist')(process.argv.slice(2));

const W = 1024;
const H = 1024;
// Bluesky crops profile pictures to a circle. We render the gradient inside an
// explicit circle (transparent corners) and shrink the emoji to ~64% of the
// canvas so it sits comfortably inside the circular crop with breathing room
// on every side, not just left/right.
const CIRCLE_R = 500;       // 24 px ring of safety against the bounding box
const EMOJI_SIZE = 660;

const CONFIGS = {
  bus: {
    codepoint: '1f68c',     // 🚌
    bgInner: '#ffe98a',
    bgOuter: '#f9b928',
    out: 'avatar-bus.png',
  },
  train: {
    codepoint: '1f687',     // 🚇 (metro)
    bgInner: '#9bc7e8',
    bgOuter: '#1f5d8c',
    out: 'avatar-train.png',
  },
  alerts: {
    codepoint: '26a0',      // ⚠
    bgInner: '#ffd089',
    bgOuter: '#d94a1f',
    out: 'avatar-alerts.png',
  },
};

async function renderOne(kind) {
  const cfg = CONFIGS[kind];
  if (!cfg) throw new Error(`Unknown avatar kind: ${kind}`);
  const url = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${cfg.codepoint}.svg`;
  console.log(`[${kind}] fetching ${url}...`);
  const { data: svg } = await axios.get(url, { responseType: 'text', timeout: 30000 });

  // Disc on a transparent square so the avatar reads correctly even on
  // platforms that don't crop to a circle.
  const cx = W / 2;
  const cy = H / 2;
  const composite = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="bg" cx="50%" cy="42%" r="60%">
        <stop offset="0%" stop-color="${cfg.bgInner}"/>
        <stop offset="100%" stop-color="${cfg.bgOuter}"/>
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${CIRCLE_R}" fill="url(#bg)"/>
    <circle cx="${cx}" cy="${cy}" r="${CIRCLE_R - 6}" fill="none"
            stroke="rgba(255,255,255,0.18)" stroke-width="3"/>
  </svg>`;

  const outPath = Path.join(__dirname, '..', 'assets', cfg.out);
  Fs.ensureDirSync(Path.dirname(outPath));

  // Default sharp density for SVGs with explicit width/height — overriding
  // would scale the canvas without scaling the emoji composited on top.
  const bgBuffer = await sharp(Buffer.from(composite)).png().toBuffer();
  // .trim() removes Twemoji's built-in transparent padding so center alignment works.
  const emojiBuffer = await sharp(Buffer.from(svg), { density: 600 })
    .png()
    .trim()
    .resize(EMOJI_SIZE, EMOJI_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  await sharp(bgBuffer)
    .composite([{ input: emojiBuffer, gravity: 'center' }])
    .png()
    .toFile(outPath);

  console.log(`[${kind}] wrote ${outPath}`);
}

async function main() {
  const kinds = argv.kind ? [argv.kind] : Object.keys(CONFIGS);
  for (const k of kinds) await renderOne(k);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
