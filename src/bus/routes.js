// Display names keyed by CTA's `rt` value. Shared by both visualizations.
// Sorted by route number; express (X) variants follow their base number.
const names = {
  '6':   'Jackson Park Express',
  '8':   'Halsted',
  '9':   'Ashland',
  'X9':  'Ashland Express',
  '20':  'Madison',
  '22':  'Clark',
  '26':  'South Shore Express',
  '29':  'State',
  '36':  'Broadway',
  '49':  'Western',
  'X49': 'Western Express',
  '50':  'Damen',
  '53':  'Pulaski',
  '55':  'Garfield',
  '56':  'Milwaukee',
  '60':  'Blue Island / 26th',
  '62':  'Archer',
  '66':  'Chicago',
  '72':  'North',
  '73':  'Armitage',
  '76':  'Diversey',
  '77':  'Belmont',
  '79':  '79th',
  '80':  'Irving Park',
  '82':  'Kimball - Homan',
  '95':  '95th',
  '146': 'Inner Lake Shore / Michigan Express',
  '147': 'Outer Lake Shore Express',
  '151': 'Sheridan',
};

// Routes polled for bunching events. Favors coverage — any high-frequency route
// where "two buses within 1000 ft" is meaningful content.
const bunching = ['6', '8', '9', 'X9', '20', '22', '26', '29', '36', '49', 'X49', '55', '56', '60', '62', '66', '72', '76', '77', '79', '80', '82', '95', '146', '147', '151'];

// Routes eligible for the 60-minute speedmap. Favors density — only routes with
// enough active buses to fill most segments with real data during a one-hour window.
const speedmap = ['8', '9', 'X9', '22', '26', '36', '49', 'X49', '50', '53', '56', '66', '72', '73', '76', '77', '79', '80', '95', '151'];

// Routes polled for gap detection. Starts aligned with `bunching` — any route
// where "two buses close together" is meaningful is also one where "no bus for
// a long stretch" is meaningful — but kept as its own list so the two can
// diverge as we tune each feature independently.
const gaps = ['6', '8', '9', 'X9', '20', '22', '26', '29', '36', '49', 'X49', '50', '55', '60', '62', '66', '72', '76', '77', '79', '80', '82', '95', '146', '147', '151'];

// Routes polled for ghost-bus detection. Independent of bunching/gaps: a
// dedicated observer cron (scripts/observeGhosts.js) fetches positions for
// these routes on a fixed cadence so the hourly rollup has consistent coverage
// regardless of what other jobs sampled.
const ghosts = ['6', '8', '9', 'X9', '20', '22', '26', '29', '36', '49', 'X49', '50', '55', '60', '62', '66', '72', '76', '77', '79', '80', '82', '95', '146', '147', '151'];

module.exports = { names, bunching, speedmap, gaps, ghosts };
