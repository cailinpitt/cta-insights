const axios = require('axios');
const { recordTrainObservations } = require('./observations');

const BASE = 'http://lapi.transitchicago.com/api/1.0';
const ALL_LINES = ['red', 'blue', 'brn', 'g', 'org', 'p', 'pink', 'y'];

// Official CTA line colors (hex without leading #) for Mapbox overlays and post text.
const LINE_COLORS = {
  red:  'c60c30',
  blue: '00a1de',
  brn:  '62361b',
  g:    '009b3a',
  org:  'f9461c',
  p:    '522398',
  pink: 'e27ea6',
  y:    'f9e300',
};

const LINE_NAMES = {
  red: 'Red', blue: 'Blue', brn: 'Brown', g: 'Green',
  org: 'Orange', p: 'Purple', pink: 'Pink', y: 'Yellow',
};

// Unicode has no pink square; 🩷 (pink heart) is the closest color-block stand-in.
const LINE_EMOJI = {
  red: '🟥', blue: '🟦', brn: '🟫', g: '🟩',
  org: '🟧', p: '🟪', pink: '🩷', y: '🟨',
};

function parseTrain(line, raw) {
  return {
    line,
    rn: raw.rn,
    destination: raw.destNm,
    trDr: raw.trDr,            // Direction code — '1' or '5'. Use with destination for context.
    nextStation: raw.nextStaNm,
    approaching: raw.isApp === '1',
    delayed: raw.isDly === '1',
    lat: parseFloat(raw.lat),
    lon: parseFloat(raw.lon),
    heading: parseInt(raw.heading, 10),
  };
}

// Rough Chicagoland bounding box. Trains reporting outside this are API glitches
// (e.g. a known issue where unpositioned trains come back with lat/lon 0,0).
function isInChicagoland(lat, lon) {
  return lat > 41 && lat < 43 && lon > -88.5 && lon < -87;
}

async function getAllTrainPositions(lines = ALL_LINES) {
  const { data } = await axios.get(`${BASE}/ttpositions.aspx`, {
    params: { key: process.env.CTA_TRAIN_KEY, rt: lines.join(','), outputType: 'JSON' },
    timeout: 15000,
  });
  const body = data.ctatt;
  if (body.errCd !== '0') throw new Error(`Train API error ${body.errCd}: ${body.errNm}`);

  const trains = [];
  let filtered = 0;
  for (const route of body.route || []) {
    const line = route['@name'];
    // API returns `train` as an object when there's exactly one train on the line,
    // and as an array otherwise. Normalize.
    const raws = Array.isArray(route.train) ? route.train : route.train ? [route.train] : [];
    for (const raw of raws) {
      const train = parseTrain(line, raw);
      if (!isInChicagoland(train.lat, train.lon)) {
        filtered++;
        continue;
      }
      trains.push(train);
    }
  }
  if (filtered > 0) console.log(`Filtered ${filtered} train(s) with out-of-bounds coordinates`);
  recordTrainObservations(trains);
  return trains;
}

module.exports = { getAllTrainPositions, LINE_COLORS, LINE_NAMES, LINE_EMOJI, ALL_LINES };
