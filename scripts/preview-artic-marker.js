// Renders side-by-side standard vs articulated bus markers on a plain dark
// background. No Mapbox required — just exercises the SVG composite path.
require('../src/shared/env');
const Path = require('node:path');
const Fs = require('fs-extra');
const sharp = require('sharp');
const { buildBusMarker } = require('../src/map/common');

const W = 600;
const H = 320;
const RADIUS = 48;
const BUS_COLOR = 'ff2a6d';

function panel(x, y, label, articulated) {
  return [
    buildBusMarker({ x, y, radius: RADIUS, color: BUS_COLOR, articulated }),
    `<text x="${x}" y="${y + RADIUS + 36}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="bold" fill="#fff">${label}</text>`,
  ].join('');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#1c1c1c"/>
  <text x="${W / 2}" y="44" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="bold" fill="#fff">Bus markers</text>
  ${panel(W / 3, 160, 'Standard (40 ft)', false)}
  ${panel((2 * W) / 3, 160, 'Articulated (60 ft)', true)}
</svg>`;

async function main() {
  const out = Path.join(__dirname, '..', 'assets', 'preview-artic-marker.png');
  Fs.ensureDirSync(Path.dirname(out));
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(`Wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
