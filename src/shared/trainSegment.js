// Spatial relevance check for alert quote-posting: does `station` lie on the
// segment between `fromStation` and `toStation` on a given line, optionally
// constrained to a direction? Used to decide whether a bunching/gap post on a
// specific station should be quote-replied into an active alert thread.
//
// Fail-closed: any unresolved station name returns false. We'd rather miss a
// quote-post than spam an unrelated thread.

const trainStations = require('../train/data/trainStations.json');
const trainLines = require('../train/data/trainLines.json');
const { snapToLineWithPerp, buildLineBranches } = require('../train/speedmap.js');

// Compass → directionHint mapping per round-trip line. Round-trip lines run
// outbound (away from Loop) and inbound (toward Loop). For brn/org/pink/p we
// translate compass directions to the matching directionHint, so callers
// passing extractDirection's 'in'/'out'/'north'/etc. all work.
//
// north/south/east/west on round-trip lines: pick the branch whose terminus
// lies in that compass direction from the Loop. brn (Kimball, north): NB→out.
// org (Midway, south): SB→out. pink (54th/Cermak, southwest): WB/SB→out. p
// (Linden, north): NB→out.
const COMPASS_TO_HINT = {
  brn: { north: 'outbound', south: 'inbound', out: 'outbound', in: 'inbound' },
  org: { south: 'outbound', north: 'inbound', west: 'outbound', out: 'outbound', in: 'inbound' },
  pink: { west: 'outbound', east: 'inbound', south: 'outbound', out: 'outbound', in: 'inbound' },
  p: { north: 'outbound', south: 'inbound', out: 'outbound', in: 'inbound' },
};

const DEFAULT_BUFFER_FT = 2640; // ½ mile fallback

function normalizeStationName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveStation(name, line) {
  if (!name) return null;
  const norm = normalizeStationName(name);
  if (!norm) return null;
  const candidates = trainStations.filter((s) => s.lines?.includes(line));
  // exact match on normalized full name
  for (const s of candidates) {
    if (normalizeStationName(s.name) === norm) return s;
  }
  // exact match on base name (already stripped via normalize)
  for (const s of candidates) {
    const baseFull = s.name.toLowerCase().split(' (')[0].trim();
    if (baseFull === norm) return s;
  }
  return null;
}

function pickBranch(branches, line, direction) {
  if (branches.length === 0) return null;
  if (branches.length === 1) return branches[0];
  if (!direction) return branches[0];
  const map = COMPASS_TO_HINT[line];
  const wantHint = map ? map[direction] : null;
  if (!wantHint) return branches[0];
  const matched = branches.find((b) => b.directionHint === wantHint);
  return matched || branches[0];
}

// Median inter-station gap projected onto the chosen branch. Used as the per-
// stop buffer unit so `bufferStops=1` corresponds to one stop's slack.
function medianStationGap(branch, line) {
  const stations = trainStations.filter((s) => s.lines?.includes(line));
  if (stations.length < 2) return DEFAULT_BUFFER_FT;
  const dists = stations
    .map((s) => snapToLineWithPerp(s.lat, s.lon, branch.points, branch.cumDist).cumDist)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < dists.length; i++) gaps.push(dists[i] - dists[i - 1]);
  if (gaps.length === 0) return DEFAULT_BUFFER_FT;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return median > 0 ? median : DEFAULT_BUFFER_FT;
}

function isStationOnSegment({
  line,
  direction = null,
  station,
  fromStation,
  toStation,
  bufferStops = 1,
}) {
  if (!line || !station || !fromStation || !toStation) return false;
  const target = resolveStation(station, line);
  const from = resolveStation(fromStation, line);
  const to = resolveStation(toStation, line);
  if (!target || !from || !to) return false;

  const branches = buildLineBranches(trainLines, line);
  const branch = pickBranch(branches, line, direction);
  if (!branch || !branch.points?.length) return false;

  // If a direction was requested but the line has direction-distinct branches
  // and no branch matches the requested direction, fail closed.
  if (direction && branches.length > 1 && COMPASS_TO_HINT[line]) {
    const wantHint = COMPASS_TO_HINT[line][direction];
    if (wantHint && branch.directionHint !== wantHint) return false;
  }

  const tDist = snapToLineWithPerp(target.lat, target.lon, branch.points, branch.cumDist).cumDist;
  const fDist = snapToLineWithPerp(from.lat, from.lon, branch.points, branch.cumDist).cumDist;
  const oDist = snapToLineWithPerp(to.lat, to.lon, branch.points, branch.cumDist).cumDist;

  const segMin = Math.min(fDist, oDist);
  const segMax = Math.max(fDist, oDist);
  const buffer = bufferStops * medianStationGap(branch, line);
  return tDist >= segMin - buffer && tDist <= segMax + buffer;
}

module.exports = {
  isStationOnSegment,
  normalizeStationName,
  resolveStation,
  COMPASS_TO_HINT,
};
