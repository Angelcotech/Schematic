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
  // Minimum padding floor for degenerate bounds (single node, collinear points).
  const padX = Math.max((maxX - minX) * paddingFrac, 1);
  const padY = Math.max((maxY - minY) * paddingFrac, 1);
  return {
    ...vp,
    xMin: minX - padX,
    xMax: maxX + padX,
    yMin: minY - padY,
    yMax: maxY + padY,
  };
}
