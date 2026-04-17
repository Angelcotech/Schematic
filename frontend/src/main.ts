// Stage 1 smoke test: blank WebGL canvas with pan/zoom.
// No geometry yet — Stage 2 adds the hardcoded mock graph.

import { initGL, resizeCanvas, render } from "./webgl/renderer.js";
import { createOverlay, resizeOverlay, clearOverlay } from "./webgl/overlayLayer.js";
import { panBy, pixelToData, zoom, type ViewportState } from "./webgl/viewport.js";

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[schematic] element #${id} not found`);
  return el as T;
}

const canvas = requireEl<HTMLCanvasElement>("canvas");
const container = canvas.parentElement;
if (!container) throw new Error("[schematic] canvas has no parent — cannot mount overlay");

const ctx = initGL(canvas);
const overlay = createOverlay(container);

let viewport: ViewportState = {
  xMin: -10,
  xMax: 10,
  yMin: -10,
  yMax: 10,
  width: canvas.clientWidth,
  height: canvas.clientHeight,
};

function resize(): void {
  viewport.width = canvas.clientWidth;
  viewport.height = canvas.clientHeight;
  resizeCanvas(ctx);
  resizeOverlay(overlay);
  requestFrame();
}

window.addEventListener("resize", resize);

// --- Mouse: drag to pan ---
let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});

window.addEventListener("mouseup", () => {
  dragging = false;
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  viewport = panBy(viewport, dx, dy);
  requestFrame();
});

// --- Wheel: zoom around cursor ---
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const { x, y } = pixelToData(viewport, px, py);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    viewport = zoom(viewport, x, y, factor);
    requestFrame();
  },
  { passive: false },
);

// --- Render loop: on-demand (no RAF spin when nothing changed) ---
let frameQueued = false;

function requestFrame(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    render(ctx, viewport, []); // no draws yet
    clearOverlay(overlay);
    // Stage 1: draw a simple status hint so the user can see it's alive.
    const { ctx: c2d } = overlay;
    c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    c2d.fillStyle = "rgba(200, 200, 200, 0.5)";
    c2d.textAlign = "left";
    c2d.textBaseline = "top";
    c2d.fillText(
      `Schematic — Stage 1 smoke test. Viewport: x[${viewport.xMin.toFixed(2)}, ${viewport.xMax.toFixed(2)}] y[${viewport.yMin.toFixed(2)}, ${viewport.yMax.toFixed(2)}]`,
      8,
      8,
    );
  });
}

resize();

console.log("[schematic] Stage 1 smoke test running. Scroll to zoom, drag to pan.");
