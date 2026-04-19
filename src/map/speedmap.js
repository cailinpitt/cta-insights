const sharp = require('sharp');
const { encode } = require('../shared/polyline');
const { cumulativeDistances } = require('../shared/geo');
const { colorForBusSpeed, colorForTrainSpeed } = require('../speedmap');
const { offsetPolyline } = require('../trainSpeedmap');
const {
  STYLE, WIDTH, HEIGHT,
  ROUTE_HALO_COLOR,
  SPEEDMAP_SEGMENT_STROKE, SPEEDMAP_HALO_STROKE,
  sliceIntoSegments, requireMapboxToken, fetchMapboxStatic,
} = require('./common');

// Perpendicular offset for each direction's ribbon. At the typical speedmap
// zoom (~10-25 mi line across 1200px) this is ~3-5px on each side of the
// centerline — enough for the two ribbons to read as distinct without the
// rendered path straying far from the physical track.
const DUAL_DIR_OFFSET_FT = 250;

async function renderSpeedmap(pattern, binSpeeds) {
  const points = pattern.points; // { lat, lon, ... }
  const cumDist = cumulativeDistances(points);
  const slices = sliceIntoSegments(points, cumDist, binSpeeds.length);

  // Full-route dark halo rendered first, then each colored segment layered on top.
  const fullEncoded = encodeURIComponent(encode(points.map((p) => [p.lat, p.lon])));
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const encoded = encodeURIComponent(encode(slices[i].map((p) => [p.lat, p.lon])));
    const color = colorForBusSpeed(binSpeeds[i]);
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
  }

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=30`;
  const data = await fetchMapboxStatic(url);
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

/**
 * Render a dual-direction speedmap. `branches` is an array of
 * `{ points, cumDist, binSpeedsByDir }` where points is [[lat, lon], ...]
 * (train-line polyline shape). Branched lines (Green) pass multiple; all
 * other lines pass a single-element array.
 */
async function renderTrainSpeedmap(branches, lineColor) {
  const overlays = [];

  for (const branch of branches) {
    const { points, cumDist, binSpeedsByDir } = branch;
    overlays.push(`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encodeURIComponent(encode(points))})`);

    const dirs = Object.keys(binSpeedsByDir);
    const offsetFor = (i) => {
      if (dirs.length === 1) return 0;
      return i === 0 ? DUAL_DIR_OFFSET_FT : -DUAL_DIR_OFFSET_FT;
    };

    dirs.forEach((trDr, i) => {
      const binSpeeds = binSpeedsByDir[trDr];
      const offsetFt = offsetFor(i);
      const ribbonPairs = offsetFt === 0 ? points : offsetPolyline(points, offsetFt);
      const ribbonObjs = ribbonPairs.map(([lat, lon]) => ({ lat, lon }));
      const slices = sliceIntoSegments(ribbonObjs, cumDist, binSpeeds.length);
      for (let b = 0; b < slices.length; b++) {
        if (slices[b].length < 2) continue;
        const pairSlice = slices[b].map((p) => [p.lat, p.lon]);
        const encoded = encodeURIComponent(encode(pairSlice));
        const color = colorForTrainSpeed(binSpeeds[b]);
        overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
      }
    });
  }

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;
  const data = await fetchMapboxStatic(url);
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderSpeedmap, renderTrainSpeedmap };
