// Stage 5: live pipeline. CC hook → daemon → WebSocket → this page. The
// GraphStore mirrors the daemon's per-workspace NodeState; the render loop
// reads from it. Stage 2's mock graph is still around in mock-graph.ts as a
// reference but is no longer loaded here.

import type { NodeState } from "@shared/node-state.js";
import type { Workspace } from "@shared/workspace.js";
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
import { GraphStore } from "./state/graph-store.js";
import { DaemonWSClient, type ConnectionState } from "./state/ws-client.js";

const DAEMON_ORIGIN = `http://${window.location.hostname}:7777`;
const DAEMON_WS = `ws://${window.location.hostname}:7777/ws`;

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

const store = new GraphStore();

let nodeBuffers: NodeBuffers = buildNodeBuffers(ctx, []);
let edgeBuffer: EdgeBuffer | null = null;

function rebuildBuffers(): void {
  destroyNodeBuffers(ctx, nodeBuffers);
  destroyEdgeBuffer(ctx, edgeBuffer);
  const nodes = store.all();
  nodeBuffers = buildNodeBuffers(ctx, nodes);
  edgeBuffer = buildEdgeBuffer(ctx, nodes, []); // no edges in bootstrap mode
}

// --- Viewport ---
let viewport: ViewportState = {
  xMin: -10, xMax: 10, yMin: -10, yMax: 10,
  width: canvas.clientWidth, height: canvas.clientHeight,
};

function fitToCurrentNodes(): void {
  const nodes = store.all();
  if (nodes.length === 0) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  viewport = fitToBounds(viewport, minX, maxX, minY, maxY, 0.1);
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
  for (const n of store.all()) {
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

// --- Workspace + connection state (rendered in the status line) ---
interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  connection: ConnectionState;
}
const app: AppState = {
  workspaces: [],
  activeWorkspaceId: null,
  connection: "closed",
};

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
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = hitTest(viewport, store.all(), px, py);
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
    if (Math.abs(e.clientX - dragStartX) > 3 || Math.abs(e.clientY - dragStartY) > 3) {
      didDrag = true;
    }
    if (didDrag) {
      viewport = panBy(viewport, dx, dy);
      requestFrame();
    }
    return;
  }

  if (cursorPx >= 0 && cursorPx <= viewport.width && cursorPy >= 0 && cursorPy <= viewport.height) {
    const hit = hitTest(viewport, store.all(), cursorPx, cursorPy);
    setHover(hit ? hit.id : null);
  } else {
    setHover(null);
  }
});

const ZOOM_THRESHOLD = 80;
const ZOOM_STEP_FACTOR = 1.08;
let zoomAccum = 0;

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
  if (e.code === "Escape") setSelection(null);
  else if (e.code === "KeyF") {
    e.preventDefault();
    fitToCurrentNodes();
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
      ...(edgeBuffer ? edgeDraw(ctx, edgeBuffer) : []),
      ...nodeDraws(ctx, nodeBuffers),
    ];
    render(ctx, viewport, draws);
    drawOverlay();
  });
}

function drawOverlay(): void {
  clearOverlay(overlay);
  const { ctx: c2d } = overlay;
  c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  c2d.fillStyle = "rgba(200, 200, 200, 0.6)";
  c2d.textAlign = "left";
  c2d.textBaseline = "top";
  c2d.fillText(statusLine(), 8, 8);

  if (store.all().length === 0) {
    c2d.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
    c2d.fillStyle = "rgba(200, 200, 200, 0.35)";
    c2d.textAlign = "center";
    c2d.textBaseline = "middle";
    c2d.fillText(
      "waiting for Claude Code activity…",
      overlay.canvas.clientWidth / 2,
      overlay.canvas.clientHeight / 2,
    );
  }

  if (hoveredNodeId !== null) {
    const n = store.get(hoveredNodeId);
    if (n) {
      const metric = tooltipMetric(n);
      drawTooltip(overlay, cursorPx, cursorPy, metric === "" ? [n.name] : [n.name, metric]);
    }
  }
}

function statusLine(): string {
  const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId);
  const connTxt = app.connection === "open" ? "●" : app.connection === "connecting" ? "◐" : "○";
  const wsTxt = ws ? `${ws.name} (${ws.state})` : "no workspace";
  const count = store.all().length;
  return `${connTxt} daemon  —  workspace: ${wsTxt}  —  ${count} nodes`;
}

function tooltipMetric(n: NodeState): string {
  if (n.kind === "file") return n.line_count > 0 ? `${n.line_count} lines` : (n.language ?? "");
  if (n.kind === "symbol" && n.signature) return n.signature;
  if (n.kind === "module") return "module";
  return "";
}

// --- Wire up GraphStore → render ---
store.subscribe(() => {
  rebuildBuffers();
  requestFrame();
});

// --- Bootstrap: discover a workspace and open a WS connection ---
async function bootstrap(): Promise<void> {
  const wsList = await fetchWorkspaces();
  app.workspaces = wsList;

  const urlParam = new URLSearchParams(window.location.search).get("w");
  const chosen =
    (urlParam && wsList.find((w) => w.id === urlParam)) ??
    wsList.find((w) => w.state === "active") ??
    null;
  app.activeWorkspaceId = chosen ? chosen.id : null;

  if (chosen) {
    const initial = await fetchWorkspaceNodes(chosen.id);
    store.replaceAll(initial);
    if (initial.length > 0) fitToCurrentNodes();
  }

  const client = new DaemonWSClient({
    url: DAEMON_WS,
    ...(chosen ? { workspaceId: chosen.id } : {}),
    onEvent: (event) => {
      if (event.type === "node.state_change") {
        store.applyEvent(event, app.activeWorkspaceId);
      } else if (event.type === "workspace.activated" || event.type === "workspace.resumed") {
        // refresh workspaces list so status line reflects it
        void fetchWorkspaces().then((list) => { app.workspaces = list; requestFrame(); });
      }
    },
    onStateChange: (state) => {
      app.connection = state;
      requestFrame();
    },
  });
  client.connect();
}

async function fetchWorkspaces(): Promise<Workspace[]> {
  const r = await fetch(`${DAEMON_ORIGIN}/workspaces`);
  if (!r.ok) throw new Error(`[schematic] /workspaces failed: ${r.status}`);
  return r.json() as Promise<Workspace[]>;
}

async function fetchWorkspaceNodes(id: string): Promise<NodeState[]> {
  const r = await fetch(`${DAEMON_ORIGIN}/workspaces/${id}/nodes`);
  if (!r.ok) throw new Error(`[schematic] /workspaces/${id}/nodes failed: ${r.status}`);
  return r.json() as Promise<NodeState[]>;
}

resize();
bootstrap().catch((e) => {
  console.error("[schematic] bootstrap failed:", e);
  app.connection = "closed";
  requestFrame();
});
