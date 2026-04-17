// Stage 5: live pipeline. CC hook → daemon → WebSocket → this page. The
// GraphStore mirrors the daemon's per-workspace NodeState; the render loop
// reads from it. Stage 2's mock graph is still around in mock-graph.ts as a
// reference but is no longer loaded here.

import type { Edge } from "@shared/edge.js";
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
  dataToPixel,
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
import { aggregateActivity } from "./graph/aggregation.js";
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
let edges: Edge[] = [];

let nodeBuffers: NodeBuffers = buildNodeBuffers(ctx, []);
let edgeBuffer: EdgeBuffer | null = null;

// --- Zoom-tier LOD ---
// Tier 0: only modules visible. File → file edges collapse into
//         module → module aggregated edges with thickness = count.
// Tier 1+: everything visible, raw edges.
// Threshold: if files would render smaller than MIN_FILE_PIXELS on screen,
// drop to tier 0.
const MIN_FILE_PIXELS = 55;

function computeTier(): 0 | 1 {
  const allNodes = store.all();
  const files = allNodes.filter((n) => n.kind === "file");
  if (files.length === 0) return 1;
  const visibleDataWidth = viewport.xMax - viewport.xMin;
  if (visibleDataWidth <= 0) return 1;
  // Use the smallest file width as the signal — if *any* file is too small
  // to be legible, pull back to module-only tier.
  const minFileW = Math.min(...files.map((f) => f.width));
  const screenW = (minFileW / visibleDataWidth) * canvas.clientWidth;
  return screenW >= MIN_FILE_PIXELS ? 1 : 0;
}

function aggregateEdgesByModule(rawEdges: Edge[], nodes: NodeState[]): Edge[] {
  const parentOf = new Map<string, string>();
  for (const n of nodes) if (n.parent) parentOf.set(n.id, n.parent);
  const counts = new Map<string, number>();
  for (const e of rawEdges) {
    const srcMod = parentOf.get(e.source);
    const dstMod = parentOf.get(e.target);
    if (!srcMod || !dstMod) continue;
    if (srcMod === dstMod) continue; // intra-module edges don't cross boundaries
    const key = `${srcMod}|${dstMod}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Edge[] = [];
  for (const [key, count] of counts) {
    const sep = key.indexOf("|");
    out.push({
      source: key.slice(0, sep),
      target: key.slice(sep + 1),
      kind: "import",
      highlighted: false,
      weight: count,
    });
  }
  return out;
}

let currentTier: 0 | 1 = 1;

function rebuildBuffers(): void {
  destroyNodeBuffers(ctx, nodeBuffers);
  destroyEdgeBuffer(ctx, edgeBuffer);
  const allNodes = store.all();

  // Roll up leaf state into module aggregates so the renderer can glow
  // modules whose children are active.
  aggregateActivity(allNodes);

  const tier = computeTier();
  currentTier = tier;

  const visibleNodes = tier === 0
    ? allNodes.filter((n) => n.kind === "module")
    : allNodes;
  nodeBuffers = buildNodeBuffers(ctx, visibleNodes);

  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const edgesToShow = tier === 0
    ? aggregateEdgesByModule(edges, allNodes)
    : edges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target));
  edgeBuffer = buildEdgeBuffer(ctx, visibleNodes, edgesToShow);
}

// Track whether the tier has crossed a threshold since the last frame so
// we can trigger a cheap buffer rebuild only when needed (zoom in/out is
// the common case that changes which buffer set is right).
function maybeRebuildForTier(): void {
  const tier = computeTier();
  if (tier !== currentTier) {
    rebuildBuffers();
  }
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
interface ExtractionProgress {
  phase: string;
  processed: number;
  total: number;
}
interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  connection: ConnectionState;
  progress: ExtractionProgress | null;
}
const app: AppState = {
  workspaces: [],
  activeWorkspaceId: null,
  connection: "closed",
  progress: null,
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

// --- Drag state: one of "viewport" (pan), "node" (module drag), or null.
type DragMode = null | { kind: "viewport" } | {
  kind: "node";
  rootId: string;
  subtreeIds: string[];
  startPositions: Map<string, { x: number; y: number }>;
  startDataX: number; // cursor in data space at drag start
  startDataY: number;
  movedIds: Set<string>; // everything touched this drag (includes push-apart)
};

let drag: DragMode = null;
let dragStartScreenX = 0, dragStartScreenY = 0;
let didDrag = false;
let lastX = 0, lastY = 0;

function subtreeOf(rootId: string): string[] {
  const root = store.get(rootId);
  if (!root) return [rootId];
  if (!root.children) return [rootId];
  return [rootId, ...root.children];
}

function hitTestVisible(px: number, py: number): NodeState | null {
  const nodes = currentTier === 0
    ? store.all().filter((n) => n.kind === "module")
    : store.all();
  return hitTest(viewport, nodes, px, py);
}

canvas.addEventListener("mousedown", (e) => {
  didDrag = false;
  dragStartScreenX = e.clientX;
  dragStartScreenY = e.clientY;
  lastX = e.clientX;
  lastY = e.clientY;

  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const hit = hitTestVisible(px, py);

  // Only modules are draggable in v1. Files/symbols still select on click.
  if (hit && hit.kind === "module") {
    const subtreeIds = subtreeOf(hit.id);
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const id of subtreeIds) {
      const n = store.get(id);
      if (n) startPositions.set(id, { x: n.x, y: n.y });
    }
    // Also snapshot other modules + their children in case push-apart moves them.
    for (const n of store.all()) {
      if (n.kind === "module" && n.id !== hit.id) {
        startPositions.set(n.id, { x: n.x, y: n.y });
        if (n.children) {
          for (const childId of n.children) {
            const child = store.get(childId);
            if (child) startPositions.set(childId, { x: child.x, y: child.y });
          }
        }
      }
    }
    const { x: dx0, y: dy0 } = pixelToData(viewport, px, py);
    drag = {
      kind: "node",
      rootId: hit.id,
      subtreeIds,
      startPositions,
      startDataX: dx0,
      startDataY: dy0,
      movedIds: new Set(subtreeIds),
    };
    canvas.style.cursor = "grabbing";
  } else {
    drag = { kind: "viewport" };
  }
});

window.addEventListener("mouseup", (e) => {
  if (!drag) return;
  const wasNodeDrag = drag.kind === "node" ? drag : null;
  drag = null;
  canvas.style.cursor = "default";

  if (!didDrag) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = hitTestVisible(px, py);
    setSelection(hit ? hit.id : null);
    return;
  }

  if (wasNodeDrag) {
    // Persist manual positions for the dragged subtree + any modules
    // displaced by push-apart.
    const positions: Array<{ node_id: string; x: number; y: number }> = [];
    for (const id of wasNodeDrag.movedIds) {
      const n = store.get(id);
      if (n) positions.push({ node_id: id, x: n.x, y: n.y });
    }
    void persistPositions(positions);
  }
});

window.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  cursorPx = e.clientX - rect.left;
  cursorPy = e.clientY - rect.top;

  if (drag) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (Math.abs(e.clientX - dragStartScreenX) > 3 || Math.abs(e.clientY - dragStartScreenY) > 3) {
      didDrag = true;
    }
    if (!didDrag) return;

    if (drag.kind === "viewport") {
      viewport = panBy(viewport, dx, dy);
      requestFrame();
      return;
    }

    // Node drag: translate the dragged subtree to follow the cursor in
    // data space, then run a single-pass AABB push-apart against other
    // modules so siblings displace cleanly.
    const { x: cx, y: cy } = pixelToData(viewport, cursorPx, cursorPy);
    const totalDx = cx - drag.startDataX;
    const totalDy = cy - drag.startDataY;
    for (const id of drag.subtreeIds) {
      const start = drag.startPositions.get(id);
      const node = store.get(id);
      if (!start || !node) continue;
      node.x = start.x + totalDx;
      node.y = start.y + totalDy;
    }
    resolvePushApart(drag);
    rebuildBuffers();
    requestFrame();
    return;
  }

  if (cursorPx >= 0 && cursorPx <= viewport.width && cursorPy >= 0 && cursorPy <= viewport.height) {
    const hit = hitTestVisible(cursorPx, cursorPy);
    setHover(hit ? hit.id : null);
  } else {
    setHover(null);
  }
});

// Minimum-translation-vector push-apart between the dragged module and
// every other top-level module. Resets sibling modules to their pre-drag
// positions before resolving, so repeated drag motion doesn't compound
// previous push deltas.
function resolvePushApart(d: Extract<DragMode, { kind: "node" }>): void {
  const dragged = store.get(d.rootId);
  if (!dragged) return;

  const modules = store.all().filter((n) => n.kind === "module");

  for (const other of modules) {
    if (other.id === d.rootId) continue;

    // Reset to pre-drag so push deltas don't accumulate.
    const start = d.startPositions.get(other.id);
    if (start) {
      const dx = start.x - other.x;
      const dy = start.y - other.y;
      other.x = start.x;
      other.y = start.y;
      if (other.children) {
        for (const childId of other.children) {
          const child = store.get(childId);
          const childStart = d.startPositions.get(childId);
          if (child && childStart) {
            child.x = childStart.x;
            child.y = childStart.y;
          } else if (child) {
            child.x += dx;
            child.y += dy;
          }
        }
      }
    }
    d.movedIds.delete(other.id);
    if (other.children) for (const c of other.children) d.movedIds.delete(c);

    // Now compute overlap against the (freshly positioned) dragged module.
    const overlapX = Math.min(dragged.x + dragged.width, other.x + other.width)
                   - Math.max(dragged.x, other.x);
    const overlapY = Math.min(dragged.y + dragged.height, other.y + other.height)
                   - Math.max(dragged.y, other.y);
    if (overlapX <= 0 || overlapY <= 0) continue;

    // Push along the shorter axis.
    const sign = (a: number) => (a >= 0 ? 1 : -1);
    let shiftX = 0, shiftY = 0;
    if (overlapX < overlapY) {
      const dir = sign((other.x + other.width / 2) - (dragged.x + dragged.width / 2));
      shiftX = dir * (overlapX + 0.05);
    } else {
      const dir = sign((other.y + other.height / 2) - (dragged.y + dragged.height / 2));
      shiftY = dir * (overlapY + 0.05);
    }
    other.x += shiftX;
    other.y += shiftY;
    d.movedIds.add(other.id);
    if (other.children) {
      for (const childId of other.children) {
        const child = store.get(childId);
        if (!child) continue;
        child.x += shiftX;
        child.y += shiftY;
        d.movedIds.add(childId);
      }
    }
  }
}

async function persistPositions(positions: Array<{ node_id: string; x: number; y: number }>): Promise<void> {
  if (!app.activeWorkspaceId) return;
  const r = await fetch(`${DAEMON_ORIGIN}/workspaces/${app.activeWorkspaceId}/positions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positions }),
  });
  if (!r.ok) console.error("[schematic] persist positions failed:", r.status);
}

async function relayout(): Promise<void> {
  if (!app.activeWorkspaceId) return;
  if (!window.confirm("Re-layout will wipe all manually-placed modules. Continue?")) return;

  // Show a placeholder immediately. Real extraction_progress events will
  // overwrite this as they arrive; graph_ready clears it.
  app.progress = { phase: "relayout", processed: 0, total: 0 };
  requestFrame();

  const r = await fetch(`${DAEMON_ORIGIN}/workspaces/${app.activeWorkspaceId}/relayout`, { method: "POST" });
  if (!r.ok) {
    app.progress = null;
    requestFrame();
    console.error("[schematic] relayout failed:", r.status);
  }
}

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

// Re-layout button rendered in the top-right corner via the overlay.
// Bounds recomputed each frame and hit-tested on click.
interface UIButton { x: number; y: number; w: number; h: number; label: string }
let relayoutBtn: UIButton | null = null;

canvas.addEventListener("click", (e) => {
  if (!relayoutBtn) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (
    px >= relayoutBtn.x && px <= relayoutBtn.x + relayoutBtn.w &&
    py >= relayoutBtn.y && py <= relayoutBtn.y + relayoutBtn.h
  ) {
    void relayout();
  }
});

// --- Render loop ---
let frameQueued = false;

function requestFrame(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    maybeRebuildForTier();
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

  // Module labels — always visible. At tier 0 they're the only identity
  // signal; at tier 1+ they label the module boxes that wrap files.
  drawModuleLabels();

  // Re-layout button in the top-right.
  if (app.activeWorkspaceId) {
    drawRelayoutButton();
  } else {
    relayoutBtn = null;
  }

  if (app.progress && app.progress.phase !== "ready") {
    drawProgressOverlay(app.progress);
  } else if (store.all().length === 0) {
    c2d.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
    c2d.fillStyle = "rgba(200, 200, 200, 0.35)";
    c2d.textAlign = "center";
    c2d.textBaseline = "middle";
    c2d.fillText(
      "no active workspace — run `schematic activate` in a repo",
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

function drawModuleLabels(): void {
  const { ctx: c2d } = overlay;
  const modules = store.all().filter((n) => n.kind === "module");
  for (const m of modules) {
    const topLeftPx = dataToPixel(viewport, m.x, m.y + m.height);
    const wPx = (m.width / (viewport.xMax - viewport.xMin)) * viewport.width;

    // Font size scales with the module's on-screen width. At tier 0 modules
    // are the only visible identity, so we give them a big legible label;
    // at tier 1+ the size damps so labels sit cleanly above the module.
    const minFontSize = currentTier === 0 ? 14 : 11;
    const maxFontSize = currentTier === 0 ? 30 : 15;
    const fontSize = Math.min(maxFontSize, Math.max(minFontSize, wPx / 9));
    c2d.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;

    // Header bar drawn ABOVE the module rectangle so it never overlaps
    // files inside. Rounded dark pill with text inside; error badge on
    // the same bar, right-aligned.
    const labelText = m.name;
    const textW = c2d.measureText(labelText).width;
    const padX = 8;
    const padY = 4;
    const headerH = fontSize + padY * 2;
    const gap = 4;

    const errs = m.aggregated_health?.error ?? 0;
    c2d.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
    const errTextW = errs > 0 ? c2d.measureText(`${errs}`).width : 0;
    const badgePad = 4;
    const badgeW = errs > 0 ? errTextW + badgePad * 2 : 0;
    const badgeGap = errs > 0 ? 6 : 0;

    const barW = textW + padX * 2 + badgeGap + badgeW;
    const barX = topLeftPx.px;
    const barY = topLeftPx.py - headerH - gap;

    // Pill background
    c2d.fillStyle = currentTier === 0 ? "rgba(40, 40, 40, 0.92)" : "rgba(30, 30, 30, 0.82)";
    roundPill(c2d, barX, barY, barW, headerH, 4);

    // Label
    c2d.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    c2d.fillStyle = currentTier === 0 ? "rgba(235, 235, 235, 0.98)" : "rgba(220, 220, 220, 0.92)";
    c2d.textAlign = "left";
    c2d.textBaseline = "middle";
    c2d.fillText(labelText, barX + padX, barY + headerH / 2);

    // Error badge inside the same bar
    if (errs > 0) {
      const bx = barX + padX + textW + badgeGap;
      const by = barY + (headerH - 14) / 2;
      c2d.fillStyle = "rgba(200, 60, 50, 0.95)";
      roundPill(c2d, bx, by, badgeW, 14, 3);
      c2d.fillStyle = "#fff";
      c2d.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
      c2d.textAlign = "left";
      c2d.textBaseline = "middle";
      c2d.fillText(`${errs}`, bx + badgePad, by + 7);
    }
  }
}

function roundPill(c2d: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, h / 2);
  c2d.beginPath();
  c2d.moveTo(x + rr, y);
  c2d.lineTo(x + w - rr, y);
  c2d.quadraticCurveTo(x + w, y, x + w, y + rr);
  c2d.lineTo(x + w, y + h - rr);
  c2d.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  c2d.lineTo(x + rr, y + h);
  c2d.quadraticCurveTo(x, y + h, x, y + h - rr);
  c2d.lineTo(x, y + rr);
  c2d.quadraticCurveTo(x, y, x + rr, y);
  c2d.closePath();
  c2d.fill();
}

function drawRelayoutButton(): void {
  const { ctx: c2d, canvas: c } = overlay;
  const label = "↻ re-layout";
  c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  const padding = 8;
  const textW = c2d.measureText(label).width;
  const w = textW + padding * 2;
  const h = 22;
  const x = c.clientWidth - w - 8;
  const y = 6;

  c2d.fillStyle = "rgba(255, 255, 255, 0.06)";
  c2d.fillRect(x, y, w, h);
  c2d.strokeStyle = "rgba(255, 255, 255, 0.15)";
  c2d.lineWidth = 1;
  c2d.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  c2d.fillStyle = "rgba(220, 220, 220, 0.85)";
  c2d.textAlign = "left";
  c2d.textBaseline = "middle";
  c2d.fillText(label, x + padding, y + h / 2);

  relayoutBtn = { x, y, w, h, label };
}

function drawProgressOverlay(p: ExtractionProgress): void {
  const { ctx: c2d, canvas: c } = overlay;
  const cx = c.clientWidth / 2;
  const cy = c.clientHeight / 2;

  // Full-screen dim so the map reads as "paused" during the operation.
  c2d.fillStyle = "rgba(10, 10, 10, 0.55)";
  c2d.fillRect(0, 0, c.clientWidth, c.clientHeight);

  c2d.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
  c2d.fillStyle = "rgba(220, 220, 220, 0.9)";
  c2d.textAlign = "center";
  c2d.textBaseline = "middle";
  const label =
    p.phase === "relayout"
      ? "Re-layout in progress…"
      : p.total > 0
        ? `Indexing workspace — ${p.phase} ${p.processed} / ${p.total}`
        : `Indexing workspace — ${p.phase}`;
  c2d.fillText(label, cx, cy - 8);

  const barW = 280;
  const barH = 4;
  const barX = cx - barW / 2;
  const barY = cy + 8;
  const frac = p.total > 0 ? Math.min(1, p.processed / p.total) : 0;
  c2d.fillStyle = "rgba(255, 255, 255, 0.1)";
  c2d.fillRect(barX, barY, barW, barH);
  c2d.fillStyle = "rgba(212, 169, 58, 0.9)";
  if (p.phase === "relayout") {
    // Indeterminate bar: oscillating segment while the daemon works.
    const t = (Date.now() / 600) % 1;
    const segW = barW * 0.25;
    const segX = barX + (barW - segW) * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
    c2d.fillRect(segX, barY, segW, barH);
    // Keep the frame loop alive so the animation ticks.
    requestFrame();
  } else {
    c2d.fillRect(barX, barY, barW * frac, barH);
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
    await loadGraph(chosen.id);
  }

  const client = new DaemonWSClient({
    url: DAEMON_WS,
    ...(chosen ? { workspaceId: chosen.id } : {}),
    onEvent: (event) => {
      if (event.type === "node.state_change") {
        store.applyEvent(event, app.activeWorkspaceId);
      } else if (event.type === "workspace.extraction_progress") {
        if (event.workspace_id === app.activeWorkspaceId) {
          app.progress = { phase: event.phase, processed: event.processed, total: event.total };
          requestFrame();
        }
      } else if (event.type === "workspace.graph_ready") {
        if (event.workspace_id === app.activeWorkspaceId) {
          app.progress = null;
          void loadGraph(event.workspace_id);
        }
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

async function loadGraph(workspaceId: string): Promise<void> {
  const graph = await fetchWorkspaceGraph(workspaceId);
  edges = graph.edges;
  store.replaceAll(graph.nodes);
  if (graph.nodes.length > 0) fitToCurrentNodes();
  requestFrame();
}

async function fetchWorkspaces(): Promise<Workspace[]> {
  const r = await fetch(`${DAEMON_ORIGIN}/workspaces`);
  if (!r.ok) throw new Error(`[schematic] /workspaces failed: ${r.status}`);
  return r.json() as Promise<Workspace[]>;
}

async function fetchWorkspaceGraph(id: string): Promise<{ nodes: NodeState[]; edges: Edge[] }> {
  const r = await fetch(`${DAEMON_ORIGIN}/workspaces/${id}/graph`);
  if (!r.ok) throw new Error(`[schematic] /workspaces/${id}/graph failed: ${r.status}`);
  return r.json() as Promise<{ nodes: NodeState[]; edges: Edge[] }>;
}

resize();
bootstrap().catch((e) => {
  console.error("[schematic] bootstrap failed:", e);
  app.connection = "closed";
  requestFrame();
});
