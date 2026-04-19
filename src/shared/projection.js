// Web Mercator projection helpers. We compute map center + zoom ourselves
// instead of using Mapbox's `auto` framing so that we know the projection
// parameters and can overlay our own labels at pixel coordinates.
//
// Mapbox Static renders at 512-pixel tiles (not the 256 default of vanilla
// Web Mercator) — verified empirically by comparing pin positions against
// projected coordinates.

const TILE_SIZE = 512;

function lonToX(lon) {
  return (lon + 180) / 360;
}

function latToY(lat) {
  const rad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2;
}

function fitZoom(bbox, widthPx, heightPx, paddingPx = 60) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const xFrac = Math.abs(lonToX(maxLon) - lonToX(minLon));
  const yFrac = Math.abs(latToY(maxLat) - latToY(minLat));
  const targetWidth = widthPx - 2 * paddingPx;
  const targetHeight = heightPx - 2 * paddingPx;
  const maxZoomX = Math.log2(targetWidth / (xFrac * TILE_SIZE));
  const maxZoomY = Math.log2(targetHeight / (yFrac * TILE_SIZE));
  return Math.min(maxZoomX, maxZoomY);
}

function project(lat, lon, centerLat, centerLon, zoom, widthPx, heightPx) {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const px = lonToX(lon) * worldSize;
  const py = latToY(lat) * worldSize;
  const cpx = lonToX(centerLon) * worldSize;
  const cpy = latToY(centerLat) * worldSize;
  return {
    x: widthPx / 2 + (px - cpx),
    y: heightPx / 2 + (py - cpy),
  };
}

module.exports = { fitZoom, project };
