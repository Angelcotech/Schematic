// Stage 2: hardcoded node graph, pan/zoom/hover/click, minimal tooltip,
// mock state animation (press space). No daemon yet — all state is local.

import type { NodeState } from "@shared/index.js";
import { initGL, resizeCanvas, render } from "./webgl/renderer.js";
import {
  clearOverlay,
  createOverlay,
  drawTooltip,
  resizeOverlay,
} from "./webgl/overlayLayer.js";
import {
  fitToBounds,
  panBy,
  pixelToData,
  zoom,
  type ViewportState,
} from "./webgl/viewport.js";
import {
  buildNodeBuffers,
  destroyNodeBuffers,
  nodeDraws,
  type NodeBuffers,
} from "./graph/node-renderer.js";
import {
  buildEdgeBuffer,
  destroyEdgeBuffer,
  edgeDraw,
  type EdgeBuffer,
} from "./graph/edge-renderer.js";
import { hitTest } from "./graph/hit-test.js";
import { MOCK_EDGES, MOCK_NODES } from "./state/mock-graph.js";

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[schematic] element #${id} not found`);
  return el as T;
}

const canvas = requireEl<HTMLCanvasElement>("canvas");
const container = canvas.parentElement;
if (!container) throw new Error("[schematic] canvas has no parent");

const ctx = initGL(canvas);
const overlay = createOverlay(container);

// --- Graph state ---
// Clone the mock nodes so state mutations stay local to this session.
const nodes: NodeState[] = MOCK_NODES.map((n) => ({ ...n }));
const edges = MOCK_EDGES;

let nodeBuffers: NodeBuffers = buildNodeBuffers(ctx, nodes);
let edgeBuffer: EdgeBuffer | null = buildEdgeBuffer(ctx, nodes, edges);

function rebuildBuffers(): void {
  destroyNodeBuffers(ctx, nodeBuffers);
  destroyEdgeBuffer(ctx, edgeBuffer);
  nodeBuffers = buildNodeBuffers(ctx, nodes);
  edgeBuffer = buildEdgeBuffer(ctx, nodes, edges);
}

// --- Viewport ---
let viewport: ViewportState = {
  xMin: -10, xMax: 10, yMin: -10, yMax: 10,
  width: canvas.clientWidth, height: canvas.clientHeight,
};

function initialFit(): void {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  viewport = fitToBounds(viewport, minX, maxX, minY, maxY, 0.08);
}

// --- Hover & selection ---
let hoveredNodeId: string | null = null;
let cursorPx = -1;
let cursorPy = -1;

function setHover(nodeId: string | null): void {
  if (nodeId === hoveredNodeId) return;
  hoveredNodeId = nodeId;
  canvas.style.cursor = nodeId ? "pointer" : "default";
  requestFrame();
}

function setSelection(nodeId: string | null): void {
  let changed = false;
  for (const n of nodes) {
    const shouldBeSelected = n.id === nodeId;
    if (shouldBeSelected && n.user_state !== "selected") {
      n.user_state = "selected";
      changed = true;
    } else if (!shouldBeSelected && n.user_state === "selected") {
      n.user_state = "none";
      changed = true;
    }
  }
  if (changed) {
    rebuildBuffers();
    requestFrame();
  }
}

// --- Mock state animation: press space to cycle a random file node ---
const FILE_IDS = nodes.filter((n) => n.kind === "file").map((n) => n.id);
let cyclingNodeId: string | null = null;
let cyclingState: string = "";

function cycleOneNode(): void {
  const id = FILE_IDS[Math.floor(Math.random() * FILE_IDS.length)];
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`[schematic] expected mock node ${id} to exist`);

  // Fit view to the node so user can actually see it cycle.
  const pad = Math.max(node.width, node.height) * 1.5;
  viewport = {
    ...viewport,
    xMin: node.x - pad,
    xMax: node.x + node.width + pad,
    yMin: node.y - pad,
    yMax: node.y + node.height + pad,
  };

  cyclingNodeId = id;
  cyclingState = "planning";
  node.ai_intent = "planning";
  node.ai_intent_since = Date.now();
  rebuildBuffers();
  requestFrame();

  setTimeout(() => {
    cyclingState = "modified";
    node.ai_intent = "modified";
    node.ai_intent_since = Date.now();
    rebuildBuffers();
    requestFrame();
  }, 2000);

  setTimeout(() => {
    cyclingState = "";
    cyclingNodeId = null;
    node.ai_intent = "idle";
    node.ai_intent_since = undefined;
    rebuildBuffers();
    requestFrame();
  }, 8000);
}

// --- Event wiring ---
function resize(): void {
  viewport.width = canvas.clientWidth;
  viewport.height = canvas.clientHeight;
  resizeCanvas(ctx);
  resizeOverlay(overlay);
  requestFrame();
}
window.addEventListener("resize", resize);

let dragging = false;
let dragStartX = 0, dragStartY = 0;
let didDrag = false;
let lastX = 0, lastY = 0;

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  didDrag = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  lastX = e.clientX;
  lastY = e.clientY;
});

window.addEventListener("mouseup", (e) => {
  if (!dragging) return;
  dragging = false;
  if (!didDrag) {
    // Treat as click — hit test for selection.
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = hitTest(viewport, nodes, px, py);
    setSelection(hit ? hit.id : null);
  }
});

window.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  cursorPx = e.clientX - rect.left;
  cursorPy = e.clientY - rect.top;

  if (dragging) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // 3 pixel dead-zone so a click isn't mistaken for a micro-drag.
    if (Math.abs(e.clientX - dragStartX) > 3 || Math.abs(e.clientY - dragStartY) > 3) {
      didDrag = true;
    }
    if (didDrag) {
      viewport = panBy(viewport, dx, dy);
      requestFrame();
    }
    return;
  }

  // Hover update (only when not dragging)
  if (cursorPx >= 0 && cursorPx <= viewport.width && cursorPy >= 0 && cursorPy <= viewport.height) {
    const hit = hitTest(viewport, nodes, cursorPx, cursorPy);
    setHover(hit ? hit.id : null);
  } else {
    setHover(null);
  }
});

// Wheel / two-finger scroll zoom — accumulator + threshold pattern, ported
// from GateStack Pro's WebGLChart. Small deltas accumulate; discrete steps
// fire when the accumulator crosses the threshold. Feels grippy on trackpad
// and responsive on mouse wheel (one mouse tick ≈ one step).
let zoomAccum = 0;
const ZOOM_THRESHOLD = 80;
const ZOOM_STEP_FACTOR = 1.08;

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const { x, y } = pixelToData(viewport, px, py);

    zoomAccum += -e.deltaY;
    const steps = Math.trunc(zoomAccum / ZOOM_THRESHOLD);
    if (steps === 0) return;
    zoomAccum -= steps * ZOOM_THRESHOLD;

    const factor = Math.pow(ZOOM_STEP_FACTOR, steps);
    viewport = zoom(viewport, x, y, factor);
    requestFrame();
  },
  { passive: false },
);

document.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    cycleOneNode();
  } else if (e.code === "Escape") {
    setSelection(null);
  } else if (e.code === "KeyF") {
    e.preventDefault();
    initialFit();
    requestFrame();
  }
});

// --- Render loop ---
let frameQueued = false;

function requestFrame(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    const draws = [
      ...edgeDraw(ctx, edgeBuffer),
      ...nodeDraws(ctx, nodeBuffers),
    ];
    render(ctx, viewport, draws);

    // Overlay: tooltip if hovering a node, plus a keypress hint (temporary).
    clearOverlay(overlay);

    const { ctx: c2d } = overlay;
    c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    c2d.fillStyle = "rgba(200, 200, 200, 0.5)";
    c2d.textAlign = "left";
    c2d.textBaseline = "top";
    if (cyclingNodeId) {
      c2d.fillText(`cycling: ${cyclingNodeId} (${cyclingState})`, 8, 8);
    }

    if (hoveredNodeId !== null) {
      const n = nodes.find((x) => x.id === hoveredNodeId);
      if (n) {
        const metric = n.kind === "file" ? `${n.line_count} lines`
                     : n.kind === "symbol" && n.signature ? n.signature
                     : n.kind === "module" ? "module"
                     : n.kind;
        drawTooltip(overlay, cursorPx, cursorPy, [n.name, metric]);
      }
    }
  });
}

initialFit();
resize();

console.log("[schematic] Stage 2 — graph rendered. Hover nodes, click to select, Space to cycle a file's ai_intent, Esc to clear selection.");
