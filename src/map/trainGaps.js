const { encode } = require('../polyline');
const { buildLinePolyline } = require('../trainSpeedmap');
const {
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
} = require('./trainBunching');

// Red overlay for the stretch of track between the two bounding trains — the
// "where riders are waiting" segment. Matches the bus gap map.
const GAP_SEGMENT_COLOR = 'ff2a00';
const GAP_SEGMENT_STROKE = 10;

/**
 * Compute a static-map view for a train gap event. Reuses the train bunching
 * framing (bbox, station picks, direction arrow) by treating the leading and
 * trailing trains as a two-train "bunch", then layers a red highlight along
 * the polyline segment between them so the gap itself reads as the focal
 * element.
 */
function computeTrainGapView(gap, lineColors, trainLines, stations) {
  const bunch = { line: gap.line, trDr: gap.trDr, trains: [gap.leading, gap.trailing] };
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations, [], { fitBbox: true });

  const { points, cumDist } = buildLinePolyline(trainLines, gap.line);
  const lo = Math.min(gap.leadingTrackDist, gap.trailingTrackDist);
  const hi = Math.max(gap.leadingTrackDist, gap.trailingTrackDist);
  const gapPts = [];
  for (let i = 0; i < points.length; i++) {
    if (cumDist[i] >= lo && cumDist[i] <= hi) gapPts.push(points[i]);
  }
  if (gapPts.length >= 2) {
    // Splice the gap overlay between the line-segment paths and the station
    // pins so station markers still sit on top.
    const firstPinIdx = view.overlays.findIndex((o) => o.startsWith('pin-'));
    const insertAt = firstPinIdx === -1 ? view.overlays.length : firstPinIdx;
    const overlay = `path-${GAP_SEGMENT_STROKE}+${GAP_SEGMENT_COLOR}(${encodeURIComponent(encode(gapPts))})`;
    view.overlays.splice(insertAt, 0, overlay);
  }
  return view;
}

async function renderTrainGap(gap, lineColors, trainLines, stations) {
  const view = computeTrainGapView(gap, lineColors, trainLines, stations);
  const baseMap = await fetchTrainBunchingBaseMap(view);
  return renderTrainBunchingFrame(view, baseMap, [gap.leading, gap.trailing]);
}

module.exports = { renderTrainGap, computeTrainGapView };
