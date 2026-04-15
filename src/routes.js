// Display names keyed by CTA's `rt` value. Shared by both visualizations.
const names = {
  '22':  'Clark',
  '66':  'Chicago',
  '77':  'Belmont',
  '49':  'Western',
  '72':  'North',
  '76':  'Diversey',
  '9':   'Ashland',
  '8':   'Halsted',
  '151': 'Sheridan',
  '147': 'Outer DuSable',
  '79':  '79th',
  '36':  'Broadway',
  '60':  'Blue Island / 26th',
  '80':  'Irving Park',
  'X9':  'Ashland Express',
  'X49': 'Western Express',
};

// Routes polled for bunching events. Favors coverage — any high-frequency route
// where "two buses within 1000 ft" is meaningful content.
const bunching = ['22', '66', '77', '49', '72', '76', '9', '8', '151', '147', '79', '36', '60', '80', 'X9', 'X49'];

// Routes eligible for the 60-minute speedmap. Favors density — only routes with
// enough active buses to fill most segments with real data during a one-hour window.
// Low-frequency / express routes (147 Outer DuSable, 151 Sheridan) are deliberately
// excluded because their speedmaps end up mostly gray "no data" segments.
const speedmap = ['22', '66', '77', '49', '72', '76', '9', '8', '79', '36', '80', 'X9', 'X49'];

module.exports = { names, bunching, speedmap };
