// CTA Bus Tracker doesn't expose vehicle type. We classify by vid range,
// sourced from chicagobus.org + chicagorailfan.com cross-checks. See
// ./data/artics.json for ranges and provenance.
const articData = require('./data/artics.json');

const RANGES = Array.isArray(articData?.articRanges) ? articData.articRanges : [];

// Returns true when vid falls inside a known articulated range. Unknown vids
// (parse failures, future deliveries we haven't catalogued) return false —
// falsely classifying a 40-footer as artic is the worse failure mode.
function isArticulated(vid) {
  const n = parseInt(vid, 10);
  if (!Number.isFinite(n)) return false;
  for (const r of RANGES) {
    if (n >= r.lo && n <= r.hi) return true;
  }
  return false;
}

module.exports = { isArticulated };
