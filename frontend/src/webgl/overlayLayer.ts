// Canvas 2D overlay on top of the WebGL canvas. Used for labels, badges,
// hover tooltips — anything where text/font rendering matters.
// Stage 1 provides the surface + minimal primitives. Stages 2+ populate it
// with node labels, error badges, and tooltips.

import type { ViewportState } from "./viewport.js";
import { dataToPixel } from "./viewport.js";

export interface Overlay {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export function createOverlay(container: HTMLElement): Overlay {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none"; // overlay is visual only; events hit the WebGL canvas
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[schematic] 2D overlay context not available");

  return { canvas, ctx };
}

export function resizeOverlay(overlay: Overlay): void {
  const { canvas, ctx } = overlay;
  const dpr = window.devicePixelRatio;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  }
}

export function clearOverlay(overlay: Overlay): void {
  const { canvas, ctx } = overlay;
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
}

// --- Primitives used by node-label / tooltip / badge renderers (Stage 2+) ---

export function drawLabel(
  overlay: Overlay,
  vp: ViewportState,
  x: number,
  y: number,
  text: string,
  color = "#ddd",
  font = "11px -apple-system, BlinkMacSystemFont, sans-serif",
): void {
  const { ctx } = overlay;
  const { px, py } = dataToPixel(vp, x, y);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(text, px, py);
}

export function drawBadge(
  overlay: Overlay,
  vp: ViewportState,
  x: number,
  y: number,
  text: string,
  bg = "#c04040",
  fg = "#fff",
): void {
  const { ctx } = overlay;
  const { px, py } = dataToPixel(vp, x, y);
  ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
  const metrics = ctx.measureText(text);
  const padding = 4;
  const w = metrics.width + padding * 2;
  const h = 14;

  ctx.fillStyle = bg;
  roundRect(ctx, px, py, w, h, 3);
  ctx.fill();

  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, px + padding, py + h / 2);
}

export function drawTooltip(
  overlay: Overlay,
  cursorPx: number,
  cursorPy: number,
  lines: string[],
): void {
  if (lines.length === 0) return;
  const { ctx, canvas } = overlay;
  ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  const padding = 6;
  const lineH = 14;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const boxW = Math.max(...widths) + padding * 2;
  const boxH = lineH * lines.length + padding * 2;

  // Place to the right of cursor by default; flip left if it would overflow.
  let x = cursorPx + 12;
  const y = cursorPy + 12;
  if (x + boxW > canvas.clientWidth) x = cursorPx - 12 - boxW;

  ctx.fillStyle = "rgba(20, 20, 20, 0.95)";
  roundRect(ctx, x, y, boxW, boxH, 4);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#ddd";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + padding, y + padding + i * lineH);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
