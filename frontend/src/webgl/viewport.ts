// 2D data-space ↔ canvas-pixel coordinate math.
// Graph coordinates are plain (x, y). No time/price axis specialization.

export interface ViewportState {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  // Canvas CSS pixels (not device pixels)
  width: number;
  height: number;
}

// Zoom-to-point: the data point (centerX, centerY) stays fixed on screen
// while the viewport bounds contract/expand around it. Matches the standard
// interactive-map zoom behavior (Google Maps, Figma, GateStack Pro).
export function zoom(
  vp: ViewportState,
  centerX: number,
  centerY: number,
  factor: number,
): ViewportState {
  return {
    ...vp,
    xMin: centerX - (centerX - vp.xMin) / factor,
    xMax: centerX + (vp.xMax - centerX) / factor,
    yMin: centerY - (centerY - vp.yMin) / factor,
    yMax: centerY + (vp.yMax - centerY) / factor,
  };
}

export function panBy(vp: ViewportState, deltaXPx: number, deltaYPx: number): ViewportState {
  const dX = vp.xMax - vp.xMin;
  const dY = vp.yMax - vp.yMin;
  const tx = -(deltaXPx / vp.width) * dX;
  // Screen Y is down; data Y is up. Drag-down should pan view up (data moves down).
  const ty = (deltaYPx / vp.height) * dY;
  return {
    ...vp,
    xMin: vp.xMin + tx,
    xMax: vp.xMax + tx,
    yMin: vp.yMin + ty,
    yMax: vp.yMax + ty,
  };
}

export function pixelToData(
  vp: ViewportState,
  px: number,
  py: number,
): { x: number; y: number } {
  const dX = vp.xMax - vp.xMin;
  const dY = vp.yMax - vp.yMin;
  const x = vp.xMin + (px / vp.width) * dX;
  // Y is flipped: canvas top = yMax
  const y = vp.yMax - (py / vp.height) * dY;
  return { x, y };
}

export function dataToPixel(
  vp: ViewportState,
  x: number,
  y: number,
): { px: number; py: number } {
  const dX = vp.xMax - vp.xMin;
  const dY = vp.yMax - vp.yMin;
  const px = ((x - vp.xMin) / dX) * vp.width;
  const py = ((vp.yMax - y) / dY) * vp.height;
  return { px, py };
}

export function fitToBounds(
  vp: ViewportState,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  paddingFrac = 0.05,
): ViewportState {
  // Preserve aspect ratio: expand whichever axis is less constrained so
  // pixels-per-data-unit match horizontally and vertically. Without this
  // a wide-but-short canvas (e.g. 1600×300 data) stretches the Y axis to
  // fill, making nodes render taller than they should.
  const dataW = Math.max(1, maxX - minX);
  const dataH = Math.max(1, maxY - minY);
  const canvasAspect = vp.width / Math.max(1, vp.height);
  const dataAspect = dataW / dataH;

  const padFactor = 1 + paddingFrac * 2;
  let width: number, height: number;
  if (dataAspect > canvasAspect) {
    // Data is wider than canvas — width fills, height padded to match.
    width = dataW * padFactor;
    height = width / canvasAspect;
  } else {
    // Data is taller than canvas — height fills, width padded to match.
    height = dataH * padFactor;
    width = height * canvasAspect;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    ...vp,
    xMin: cx - width / 2,
    xMax: cx + width / 2,
    yMin: cy - height / 2,
    yMax: cy + height / 2,
  };
}
