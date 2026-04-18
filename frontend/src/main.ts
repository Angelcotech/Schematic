// Canvas-era frontend entry point. Replaces the old directory-render path.
// Data flow: fetch focused workspace → fetch its canvases → pick the active
// canvas → render its nodes+edges + overlay live file activity.
//
// Key architectural shift from pre-Stage-17 Schematic:
//   - There is no "graph" shared across the workspace — each canvas is a
//     standalone authored diagram.
//   - A file can appear as N CanvasNode instances; activity fans out to all
//     of them via the fileActivity map keyed by file_path.
//   - CC (via MCP tools) is the primary author. Users drag and rename.

import type { Workspace } from "@shared/workspace.js";
import type { Canvas, CanvasEdge, CanvasNode } from "@shared/canvas.js";
import type { FileActivity } from "@shared/file-activity.js";
import type {
  AiIntent,
  Health,
  NodeKind,
  NodeState,
} from "@shared/node-state.js";
import type { Edge } from "@shared/edge.js";
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
import { drawEdges2D, hitTestEdge } from "./graph/edge-renderer-2d.js";
import { drawProcessGroups } from "./graph/process-renderer.js";
import { hitTest } from "./graph/hit-test.js";
import { DaemonWSClient, type ConnectionState } from "./state/ws-client.js";

// Same-origin when served by daemon; Vite dev proxies.
const DAEMON_ORIGIN = "";
const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
const DAEMON_WS = `${wsProto}//${window.location.host}/ws`;

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[schematic] element #${id} not found`);
  return el as T;
}

const canvas = requireEl<HTMLCanvasElement>("canvas");
const container = canvas.parentElement;
if (!container) throw new Error("[schematic] canvas has no parent");
const tabbarEl = requireEl<HTMLDivElement>("tabbar");
const emptyStateEl = requireEl<HTMLDivElement>("empty-state");

const ctx = initGL(canvas);
const overlay = createOverlay(container);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  canvases: Canvas[];
  activeCanvasId: string | null;

  nodes: CanvasNode[];
  edges: CanvasEdge[];

  fileActivity: Map<string, FileActivity>;

  // Selection is a set so shift-click can accumulate. The node renderer's
  // `user_state: "selected"` is still a boolean per node, so we surface
  // "is this node in the set" in the toRenderNode adapter.
  selectedNodeIds: Set<string>;
  hoveredNodeId: string | null;
  hoveredEdgeId: string | null;

  connection: ConnectionState;
}

const app: AppState = {
  workspaces: [],
  activeWorkspaceId: null,
  canvases: [],
  activeCanvasId: null,
  nodes: [],
  edges: [],
  fileActivity: new Map(),
  selectedNodeIds: new Set(),
  hoveredNodeId: null,
  hoveredEdgeId: null,
  connection: "closed",
};

let viewport: ViewportState = {
  xMin: -10, xMax: 10, yMin: -10, yMax: 10,
  width: canvas.clientWidth, height: canvas.clientHeight,
};

let nodeBuffers: NodeBuffers = buildNodeBuffers(ctx, []);

let cursorPx = -1;
let cursorPy = -1;

// ---------------------------------------------------------------------------
// Render-adapter: CanvasNode + FileActivity → NodeState shape the node
// renderer already knows how to paint. Kept tight so the one-file-many-nodes
// model stays honest: visuals come entirely from the canvas node and the
// file's current activity — nothing else.
// ---------------------------------------------------------------------------

function languageForPath(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".ts": return "ts";
    case ".tsx": return "tsx";
    case ".js": case ".mjs": case ".cjs": return "js";
    case ".jsx": return "jsx";
    case ".py": return "py";
    case ".rs": return "rs";
    case ".go": return "go";
    case ".md": return "md";
    case ".json": return "json";
    default: return undefined;
  }
}

function toRenderNode(cn: CanvasNode): NodeState {
  const activity = app.fileActivity.get(cn.file_path);
  const name = cn.file_path.slice(cn.file_path.lastIndexOf("/") + 1);
  const kind: NodeKind = "file";
  const lang = languageForPath(cn.file_path);
  const ai_intent: AiIntent = activity?.ai_intent ?? "idle";
  const health: Health = activity?.health ?? "unknown";

  const node: NodeState = {
    id: cn.id,
    path: cn.file_path,
    name,
    kind,
    depth: 0,
    exports: [],
    imports: [],
    line_count: 0,
    byte_size: 0,
    x: cn.x,
    y: cn.y,
    width: cn.width,
    height: cn.height,
    manually_positioned: true,
    manually_sized: true,
    layout_locked: false,
    ai_intent,
    user_state: app.selectedNodeIds.has(cn.id) ? "selected" : "none",
    in_arch_context: false,
    aggregated_ai_intent: "idle",
    aggregated_activity_count: 0,
    aggregated_activity_ts: 0,
    aggregated_health: { ok: 0, warning: 0, error: 0 },
    health,
  };
  if (lang !== undefined) node.language = lang;
  if (activity?.ai_intent_since !== undefined) node.ai_intent_since = activity.ai_intent_since;
  if (activity?.ai_intent_tool !== undefined) node.ai_intent_tool = activity.ai_intent_tool;
  if (activity?.health_detail !== undefined) node.health_detail = activity.health_detail;
  if (activity?.health_source !== undefined) node.health_source = activity.health_source;
  return node;
}

// Edge adapter: drawEdges2D expects {source, target} as node ids; CanvasEdge
// uses {src, dst}. Trivial shim, kept here to avoid leaking vocabulary.
function toRenderEdge(ce: CanvasEdge): Edge {
  const edge: Edge = {
    source: ce.src,
    target: ce.dst,
    kind: (ce.kind ?? "custom") === "imports" ? "import"
        : ce.kind === "calls" ? "calls"
        : ce.kind === "reads" ? "type_only"   // reuse gray palette entry
        : ce.kind === "writes" ? "dynamic_import"
        : ce.kind === "control" ? "side_effect"
        : "import",
    highlighted: false,
  };
  if (ce.label !== undefined) edge.label = ce.label;
  return edge;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let frameQueued = false;
function requestFrame(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    renderAll();
  });
}

function renderAll(): void {
  const renderNodes = app.nodes.map(toRenderNode);
  const renderEdges = app.edges.map(toRenderEdge);

  destroyNodeBuffers(ctx, nodeBuffers);
  nodeBuffers = buildNodeBuffers(ctx, renderNodes);
  render(ctx, viewport, nodeDraws(ctx, nodeBuffers));

  clearOverlay(overlay);
  const c2d = overlay.ctx;

  // Process groups first — they're a subtle backdrop; edges and nodes
  // paint over them cleanly.
  drawProcessGroups(c2d, viewport, app.nodes);

  // Edges next so labels and halos paint on top.
  drawEdges2D(c2d, viewport, renderEdges, renderNodes);

  drawStatusLine(c2d);
  drawNodeLabels(c2d);

  if (app.hoveredNodeId !== null) drawHoverTooltip(c2d);
  else if (app.hoveredEdgeId !== null) drawEdgeHoverTooltip(c2d);

  // Empty state is managed via the DOM overlay (#empty-state), which is
  // shown/hidden by updateEmptyState(). No draw here.
}

function drawStatusLine(c2d: CanvasRenderingContext2D): void {
  c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  c2d.fillStyle = "rgba(200, 200, 200, 0.6)";
  c2d.textAlign = "left";
  c2d.textBaseline = "top";
  const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId);
  const cvs = app.canvases.find((c) => c.id === app.activeCanvasId);
  const parts: string[] = [
    `${app.connection === "open" ? "●" : "○"} daemon`,
    `workspace: ${ws?.name ?? "(none)"}`,
    `canvas: ${cvs?.name ?? "(none)"}`,
    `${app.nodes.length} nodes`,
  ];
  c2d.fillText(parts.join("  —  "), 8, 8);
}

function drawNodeLabels(c2d: CanvasRenderingContext2D): void {
  c2d.textAlign = "center";
  c2d.textBaseline = "middle";
  for (const cn of app.nodes) {
    const tl = dataToPixel(viewport, cn.x, cn.y + cn.height);
    const br = dataToPixel(viewport, cn.x + cn.width, cn.y);
    const wPx = br.px - tl.px;
    const hPx = br.py - tl.py;
    if (hPx < 10) continue; // too small to read
    const fontSize = Math.min(Math.max(hPx * 0.38, 10), 22);
    c2d.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    c2d.fillStyle = "rgba(240, 240, 240, 0.95)";
    const name = cn.file_path.slice(cn.file_path.lastIndexOf("/") + 1);
    const label = truncateToWidth(c2d, name, wPx - 12);
    c2d.fillText(label, (tl.px + br.px) / 2, (tl.py + br.py) / 2);
  }
}

function truncateToWidth(c2d: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (c2d.measureText(text).width <= maxW) return text;
  const ellipsis = "…";
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const w = c2d.measureText(text.slice(0, mid) + ellipsis).width;
    if (w <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : text.slice(0, lo) + ellipsis;
}

function drawHoverTooltip(_c2d: CanvasRenderingContext2D): void {
  const cn = app.nodes.find((n) => n.id === app.hoveredNodeId);
  if (!cn) return;
  const activity = app.fileActivity.get(cn.file_path);
  const lines: string[] = [cn.file_path];
  if (cn.process) lines.push(`process: ${cn.process}`);
  if (activity && activity.health !== "unknown" && activity.health !== "ok") {
    const label = activity.health === "error" ? "✗" : "⚠";
    const src = activity.health_source ? ` (${activity.health_source})` : "";
    lines.push(`${label} ${activity.health_detail ?? activity.health}${src}`);
  }
  drawTooltip(overlay, cursorPx, cursorPy, lines);
}

function drawEdgeHoverTooltip(_c2d: CanvasRenderingContext2D): void {
  const ce = app.edges.find((e) => e.id === app.hoveredEdgeId);
  if (!ce) return;
  const srcNode = app.nodes.find((n) => n.id === ce.src);
  const dstNode = app.nodes.find((n) => n.id === ce.dst);
  if (!srcNode || !dstNode) return;
  const srcName = srcNode.file_path.slice(srcNode.file_path.lastIndexOf("/") + 1);
  const dstName = dstNode.file_path.slice(dstNode.file_path.lastIndexOf("/") + 1);
  const lines: string[] = [];
  if (ce.label) lines.push(ce.label);
  lines.push(`${srcName} → ${dstName}`);
  if (ce.kind) lines.push(`kind: ${ce.kind}`);
  drawTooltip(overlay, cursorPx, cursorPy, lines);
}

// ---------------------------------------------------------------------------
// Tab bar (DOM-managed, not canvas-2D — click handling is free this way)
// ---------------------------------------------------------------------------

function renderTabs(): void {
  tabbarEl.innerHTML = "";
  for (const cv of app.canvases) {
    const chip = document.createElement("div");
    chip.className = "tab" + (cv.id === app.activeCanvasId ? " active" : "");
    chip.textContent = cv.name;
    chip.title = cv.description ?? "";
    chip.addEventListener("click", () => {
      if (cv.id === app.activeCanvasId) return;
      void switchCanvas(cv.id);
    });
    tabbarEl.appendChild(chip);
  }
  const add = document.createElement("div");
  add.className = "new-canvas";
  add.textContent = "+ new";
  add.title = "Create a new canvas";
  add.addEventListener("click", () => {
    void createCanvasPrompt();
  });
  tabbarEl.appendChild(add);
}

function updateEmptyState(): void {
  emptyStateEl.style.display =
    app.activeWorkspaceId && app.canvases.length === 0 ? "flex" : "none";
}

async function createCanvasPrompt(): Promise<void> {
  if (!app.activeWorkspaceId) return;
  const name = window.prompt("Canvas name?");
  if (!name) return;
  const r = await fetch(
    `${DAEMON_ORIGIN}/workspaces/${app.activeWorkspaceId}/canvases`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!r.ok) {
    console.error("[schematic] create canvas failed:", r.status);
    return;
  }
  // canvas.created event will refresh the tab bar; we'll switch to it too.
  const file = (await r.json()) as { canvas: Canvas };
  await switchCanvas(file.canvas.id);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function fetchJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${DAEMON_ORIGIN}${path}`);
  if (!r.ok) throw new Error(`[schematic] ${path} failed: ${r.status}`);
  return r.json() as Promise<T>;
}

async function reloadWorkspaceScope(workspaceId: string | null): Promise<void> {
  app.activeWorkspaceId = workspaceId;
  app.canvases = [];
  app.activeCanvasId = null;
  app.nodes = [];
  app.edges = [];
  app.fileActivity.clear();
  app.selectedNodeIds.clear();

  if (workspaceId) {
    app.canvases = await fetchJSON<Canvas[]>(`/workspaces/${workspaceId}/canvases`);
    const initial = app.canvases[0];
    if (initial) {
      await switchCanvas(initial.id);
    } else {
      renderTabs();
      updateEmptyState();
      requestFrame();
    }
  } else {
    renderTabs();
    updateEmptyState();
    requestFrame();
  }
}

async function switchCanvas(canvasId: string): Promise<void> {
  if (!app.activeWorkspaceId) return;
  const file = await fetchJSON<{ canvas: Canvas; nodes: CanvasNode[]; edges: CanvasEdge[] }>(
    `/workspaces/${app.activeWorkspaceId}/canvases/${canvasId}`,
  );
  app.activeCanvasId = canvasId;
  app.nodes = file.nodes;
  app.edges = file.edges;
  app.selectedNodeIds.clear();
  fitToNodes();
  renderTabs();
  updateEmptyState();
  requestFrame();
}

function fitToNodes(): void {
  if (app.nodes.length === 0) {
    viewport = { ...viewport, xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
    return;
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of app.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  viewport = fitToBounds(viewport, minX, maxX, minY, maxY, 0.15);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function resize(): void {
  viewport.width = canvas.clientWidth;
  viewport.height = canvas.clientHeight;
  resizeCanvas(ctx);
  resizeOverlay(overlay);
  requestFrame();
}
window.addEventListener("resize", resize);

type DragMode =
  | null
  | { kind: "viewport" }
  | {
      kind: "node";
      // All nodes moving together this drag; always includes the primary
      // (clicked) node first. startPositions captures their pre-drag x/y
      // so relative spacing is preserved as the group translates.
      nodeIds: string[];
      startPositions: Map<string, { x: number; y: number }>;
      startDataX: number; // cursor data coords at drag start
      startDataY: number;
    };

let drag: DragMode = null;
let dragStartScreenX = 0, dragStartScreenY = 0;
let didDrag = false;
let lastX = 0, lastY = 0;

function hitTestVisible(px: number, py: number): CanvasNode | null {
  const renderNodes = app.nodes.map(toRenderNode);
  const hit = hitTest(viewport, renderNodes, px, py);
  if (!hit) return null;
  return app.nodes.find((n) => n.id === hit.id) ?? null;
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  didDrag = false;
  dragStartScreenX = e.clientX;
  dragStartScreenY = e.clientY;
  lastX = e.clientX;
  lastY = e.clientY;
  const hit = hitTestVisible(px, py);
  if (hit) {
    // If the clicked node is already selected and we have a multi-selection,
    // drag ALL selected nodes together. Otherwise drag only the clicked one.
    const useGroup = app.selectedNodeIds.has(hit.id) && app.selectedNodeIds.size > 1;
    const nodeIds = useGroup ? Array.from(app.selectedNodeIds) : [hit.id];
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const id of nodeIds) {
      const n = app.nodes.find((nn) => nn.id === id);
      if (n) startPositions.set(id, { x: n.x, y: n.y });
    }
    const { x: dx0, y: dy0 } = pixelToData(viewport, px, py);
    drag = {
      kind: "node",
      nodeIds,
      startPositions,
      startDataX: dx0,
      startDataY: dy0,
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
    // Click without drag = selection update. Shift-click toggles membership;
    // plain click replaces the selection with the hit node (or clears it).
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = hitTestVisible(px, py);
    if (e.shiftKey) {
      if (hit) {
        if (app.selectedNodeIds.has(hit.id)) app.selectedNodeIds.delete(hit.id);
        else app.selectedNodeIds.add(hit.id);
      }
    } else {
      app.selectedNodeIds.clear();
      if (hit) app.selectedNodeIds.add(hit.id);
    }
    requestFrame();
    return;
  }
  if (wasNodeDrag && app.activeWorkspaceId && app.activeCanvasId) {
    // Persist every moved node; cheap for Schematic-scale canvases.
    for (const id of wasNodeDrag.nodeIds) {
      const n = app.nodes.find((nn) => nn.id === id);
      if (!n) continue;
      void persistNodeMove(app.activeWorkspaceId, app.activeCanvasId, n.id, n.x, n.y);
    }
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
    // drag.kind === "node" — pull into a local so the arrow callback below
    // doesn't lose the narrowing. Moves every node in nodeIds by the same
    // delta, preserving relative spacing across the dragged group.
    const nodeDrag = drag;
    const { x: cx, y: cy } = pixelToData(viewport, cursorPx, cursorPy);
    const totalDx = cx - nodeDrag.startDataX;
    const totalDy = cy - nodeDrag.startDataY;
    for (const id of nodeDrag.nodeIds) {
      const n = app.nodes.find((nn) => nn.id === id);
      const start = nodeDrag.startPositions.get(id);
      if (!n || !start) continue;
      n.x = start.x + totalDx;
      n.y = start.y + totalDy;
    }
    requestFrame();
    return;
  }
  if (cursorPx >= 0 && cursorPx <= viewport.width && cursorPy >= 0 && cursorPy <= viewport.height) {
    // Nodes take hit-test priority over edges — a cursor inside a node box
    // is always "on the node" even if an edge wire passes through that box.
    const nodeHit = hitTestVisible(cursorPx, cursorPy);
    let edgeHit: string | null = null;
    if (!nodeHit) {
      const renderNodes = app.nodes.map(toRenderNode);
      const renderEdges = app.edges.map(toRenderEdge);
      // The adapter loses the CanvasEdge.id, so recover by position.
      const hit = hitTestEdge(viewport, renderEdges, renderNodes, cursorPx, cursorPy);
      if (hit) {
        const idx = renderEdges.indexOf(hit);
        if (idx >= 0 && app.edges[idx]) edgeHit = app.edges[idx].id;
      }
    }
    const newNodeHover = nodeHit?.id ?? null;
    if (newNodeHover !== app.hoveredNodeId || edgeHit !== app.hoveredEdgeId) {
      app.hoveredNodeId = newNodeHover;
      app.hoveredEdgeId = edgeHit;
      canvas.style.cursor = newNodeHover || edgeHit ? "pointer" : "default";
      requestFrame();
    }
  } else {
    if (app.hoveredNodeId !== null || app.hoveredEdgeId !== null) {
      app.hoveredNodeId = null;
      app.hoveredEdgeId = null;
      canvas.style.cursor = "default";
      requestFrame();
    }
  }
});

async function persistNodeMove(
  wid: string, cid: string, nid: string, x: number, y: number,
): Promise<void> {
  try {
    await fetch(`${DAEMON_ORIGIN}/workspaces/${wid}/canvases/${cid}/nodes/${nid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }),
    });
  } catch {
    // Peripheral — network failures here shouldn't surface to CC.
  }
}

// Accumulate wheel input so trackpad micro-deltas don't zoom in jumpy steps.
const ZOOM_THRESHOLD = 80;
const ZOOM_STEP_FACTOR = 1.08;
let zoomAccum = 0;
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAccum += e.deltaY;
  while (zoomAccum > ZOOM_THRESHOLD) {
    viewport = zoom(viewport, 1 / ZOOM_STEP_FACTOR, cursorPx, cursorPy);
    zoomAccum -= ZOOM_THRESHOLD;
  }
  while (zoomAccum < -ZOOM_THRESHOLD) {
    viewport = zoom(viewport, ZOOM_STEP_FACTOR, cursorPx, cursorPy);
    zoomAccum += ZOOM_THRESHOLD;
  }
  requestFrame();
}, { passive: false });

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  app.workspaces = await fetchJSON<Workspace[]>("/workspaces");

  // Precedence: ?w=<id> URL param, then daemon /focus, then first active.
  const urlParam = new URLSearchParams(window.location.search).get("w");
  const focusResp = urlParam ? null : await fetchJSON<{ workspace_id: string | null }>("/focus").catch(() => null);
  const focused = focusResp?.workspace_id ?? null;
  const chosen =
    (urlParam && app.workspaces.find((w) => w.id === urlParam)) ??
    (focused && app.workspaces.find((w) => w.id === focused)) ??
    app.workspaces.find((w) => w.state === "active") ??
    null;

  await reloadWorkspaceScope(chosen ? chosen.id : null);

  const client = new DaemonWSClient({
    url: DAEMON_WS,
    ...(chosen ? { workspaceId: chosen.id } : {}),
    onEvent: (event) => {
      // file.activity is the canvas-era activity signal; node.state_change
      // from the old directory-render path is ignored.
      if (event.type === "file.activity") {
        if (event.workspace_id !== app.activeWorkspaceId) return;
        app.fileActivity.set(event.file_path, event.activity);
        requestFrame();
        return;
      }
      if (event.type === "workspace.focused") {
        if (event.workspace_id !== app.activeWorkspaceId) {
          void reloadWorkspaceScope(event.workspace_id);
          client.setWorkspace(event.workspace_id);
          void refreshWorkspaces();
        }
        return;
      }
      if (event.type === "canvas.created") {
        if (event.workspace_id !== app.activeWorkspaceId) return;
        app.canvases = [...app.canvases, event.canvas];
        renderTabs();
        updateEmptyState();
        return;
      }
      if (event.type === "canvas.updated") {
        if (event.workspace_id !== app.activeWorkspaceId) return;
        app.canvases = app.canvases.map((c) => (c.id === event.canvas.id ? event.canvas : c));
        renderTabs();
        return;
      }
      if (event.type === "canvas.deleted") {
        if (event.workspace_id !== app.activeWorkspaceId) return;
        app.canvases = app.canvases.filter((c) => c.id !== event.canvas_id);
        if (app.activeCanvasId === event.canvas_id) {
          app.activeCanvasId = null;
          app.nodes = [];
          app.edges = [];
          const fallback = app.canvases[0];
          if (fallback) void switchCanvas(fallback.id);
        }
        renderTabs();
        updateEmptyState();
        requestFrame();
        return;
      }
      if (event.type === "workspace.activated" || event.type === "workspace.resumed") {
        void refreshWorkspaces();
        return;
      }
    },
    onStateChange: (state) => {
      app.connection = state;
      requestFrame();
    },
  });
  client.connect();
}

async function refreshWorkspaces(): Promise<void> {
  app.workspaces = await fetchJSON<Workspace[]>("/workspaces");
  requestFrame();
}

resize();
bootstrap().catch((e) => {
  console.error("[schematic] bootstrap failed:", e);
  app.connection = "closed";
  requestFrame();
});
