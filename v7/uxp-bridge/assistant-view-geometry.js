'use strict';

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function rectangle(value) {
  if (!value || !['left', 'top', 'right', 'bottom'].every(key => finite(value[key]))) return null;
  const { left, top, right, bottom } = value;
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}
function matrix(value) {
  return Array.isArray(value) && value.length === 6 && value.every(finite) ? value.slice() : null;
}
function inverse(value) {
  const m = matrix(value);
  if (!m) return null;
  const [a, b, c, d, tx, ty] = m, determinant = a * d - b * c;
  const magnitude = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (!finite(determinant) || Math.abs(determinant) <= Number.EPSILON * magnitude * magnitude * 16) return null;
  const result = [d, -b, -c, a, b * ty - d * tx, c * tx - a * ty].map(n => n / determinant);
  return result.every(finite) ? result : null;
}
function point(m, p) { return { x: m[0] * p.x + m[1] * p.y + m[4], y: m[2] * p.x + m[3] * p.y + m[5] }; }
function corners(r) { return [{ x: r.left, y: r.top }, { x: r.right, y: r.top }, { x: r.right, y: r.bottom }, { x: r.left, y: r.bottom }]; }
function polygonArea(points) {
  return Math.abs(points.reduce((sum, p, index) => {
    const next = points[(index + 1) % points.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0)) / 2;
}
function clipPolygon(points, bounds) {
  let result = points;
  for (const [axis, edge, direction] of [['x', bounds.left, 1], ['x', bounds.right, -1], ['y', bounds.top, 1], ['y', bounds.bottom, -1]]) {
    const input = result; result = [];
    if (!input.length) break;
    let previous = input[input.length - 1], previousInside = direction * (previous[axis] - edge) >= 0;
    for (const current of input) {
      const inside = direction * (current[axis] - edge) >= 0;
      if (inside !== previousInside) {
        const ratio = (edge - previous[axis]) / (current[axis] - previous[axis]);
        const crossing = { x: previous.x + ratio * (current.x - previous.x), y: previous.y + ratio * (current.y - previous.y) };
        crossing[axis] = edge;
        result.push(crossing);
      }
      if (inside) result.push(current);
      previous = current; previousInside = inside;
    }
  }
  return result.filter((p, index) => {
    const previous = result[(index + result.length - 1) % result.length];
    return Math.abs(p.x - previous.x) > 1e-8 || Math.abs(p.y - previous.y) > 1e-8;
  });
}
function fail(reason) { return { ok: false, reason }; }
function displayFor(bounds, displays, platform) {
  const os = String(platform || '').toLowerCase();
  const mac = ['mac', 'macos', 'darwin', 'macintel'].includes(os);
  if (!mac && !['win', 'win32', 'windows'].includes(os)) return fail('VIEWPORT_PLATFORM_UNSUPPORTED');
  if (!Array.isArray(displays) || !displays.length) return fail('VIEWPORT_DISPLAY_CONFIGURATION_UNAVAILABLE');
  const parsed = displays.map(display => ({ bounds: rectangle(display && display.globalBounds), scale: display && display.scaleFactor }));
  if (parsed.some(display => !display.bounds || !finite(display.scale) || display.scale <= 0)) return fail('VIEWPORT_DISPLAY_CONFIGURATION_UNAVAILABLE');
  const overlaps = parsed.filter(display => Math.min(bounds.right, display.bounds.right) > Math.max(bounds.left, display.bounds.left)
    && Math.min(bounds.bottom, display.bounds.bottom) > Math.max(bounds.top, display.bounds.top));
  if (overlaps.length !== 1) return fail(overlaps.length ? 'VIEWPORT_SPANS_DISPLAYS' : 'VIEWPORT_OUTSIDE_DISPLAY');
  const display = overlaps[0], r = display.bounds;
  if (bounds.left < r.left || bounds.top < r.top || bounds.right > r.right || bounds.bottom > r.bottom) return fail('VIEWPORT_OUTSIDE_DISPLAY');
  return { ok: true, bounds: r, scaleFactor: mac ? 1 : display.scale, reportedScaleFactor: display.scale };
}
function viewportGeometry({ viewInfo, viewTransform, width, height, displays, platform }) {
  const clientBounds = rectangle(viewInfo && viewInfo.activeView && viewInfo.activeView.globalBounds);
  if (!clientBounds) return fail('VIEWPORT_CLIENT_BOUNDS_UNVERIFIED');
  if (viewInfo.activeView.visible === false || viewInfo.activeView.shown === false) return fail('VIEWPORT_WINDOW_HIDDEN');
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return fail('VIEWPORT_DOCUMENT_DIMENSIONS_UNAVAILABLE');
  const windowToCanvas = matrix(viewTransform), canvasToWindow = inverse(windowToCanvas);
  if (!canvasToWindow) return fail('VIEWPORT_TRANSFORM_INVALID');
  const display = displayFor(clientBounds, displays, platform);
  if (!display.ok) return display;
  const scale = display.scaleFactor, canvas = { left: 0, top: 0, right: width, bottom: height };
  // Adobe's viewTransform maps logical client coordinates to canvas pixels.
  // Its inverse, followed by display scaling and the client origin, maps to screen coordinates.
  const screenCanvas = corners(canvas).map(p => {
    const local = point(canvasToWindow, p);
    return { x: clientBounds.left + local.x * scale, y: clientBounds.top + local.y * scale };
  });
  if (screenCanvas.some(p => !finite(p.x) || !finite(p.y))) return fail('VIEWPORT_TRANSFORM_INVALID');
  const visibleScreen = clipPolygon(screenCanvas, clientBounds);
  const polygon = clipPolygon(visibleScreen.map(p => point(windowToCanvas, {
    x: (p.x - clientBounds.left) / scale, y: (p.y - clientBounds.top) / scale
  })), canvas);
  if (polygon.length < 3 || polygon.some(p => !finite(p.x) || !finite(p.y)) || polygonArea(polygon) <= 1e-8) return fail('VIEWPORT_EMPTY');
  const bounds = { left: Math.min(...polygon.map(p => p.x)), top: Math.min(...polygon.map(p => p.y)), right: Math.max(...polygon.map(p => p.x)), bottom: Math.max(...polygon.map(p => p.y)) };
  const area = polygonArea(polygon), envelopeArea = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
  if (!finite(area) || !finite(envelopeArea)) return fail('VIEWPORT_TRANSFORM_INVALID');
  return { ok: true, polygon, bounds, boundsKind: Math.abs(area - envelopeArea) <= Math.max(1, envelopeArea) * 1e-10 ? 'rectangle' : 'polygon-envelope',
    clientBounds, displayBounds: display.bounds, scaleFactor: scale, reportedScaleFactor: display.reportedScaleFactor,
    coordinateSpace: 'document-pixels', clientCoordinateSpace: 'screen-global', area };
}
module.exports = { rectangle, matrix, inverse, point, polygonArea, clipPolygon, viewportGeometry };
