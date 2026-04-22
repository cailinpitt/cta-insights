const { encode } = require('../../shared/polyline');
const { buildLinePolyline, pointAlongLine } = require('../../train/speedmap');
const {
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
} = require('./bunching');

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
  // Anchor the strip at the trains' actual snapped positions, not at whichever
  // polyline vertex happens to fall just inside [lo, hi]. Train polylines have
  // sparse vertices, so vertex-only filtering visibly ends the red strip short
  // of the train pin (e.g. terminating at Sheridan when the trailing train is
  // at Fullerton).
  const loPt = pointAlongLine(points, cumDist, lo);
  const hiPt = pointAlongLine(points, cumDist, hi);
  const gapPts = [];
  if (loPt) gapPts.push([loPt.lat, loPt.lon]);
  for (let i = 0; i < points.length; i++) {
    if (cumDist[i] > lo && cumDist[i] < hi) gapPts.push(points[i]);
  }
  if (hiPt) gapPts.push([hiPt.lat, hiPt.lon]);
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
