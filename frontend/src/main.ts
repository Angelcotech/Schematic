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
  drawNodes2D,
  LEGEND_LANGUAGES,
  LEGEND_HALO,
} from "./graph/node-renderer.js";
import {
  drawEdges2D,
  hitTestEdge,
  computeNodeAttachments,
  LEGEND_EDGE_KINDS,
  type NodeAttachments,
} from "./graph/edge-renderer-2d.js";
import { drawProcessGroups, hitTestProcessGroup } from "./graph/process-renderer.js";
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
const emptyStatePanelEl = requireEl<HTMLDivElement>("empty-state-panel");
const legendEl = requireEl<HTMLDivElement>("legend");
const legendBtn = requireEl<HTMLDivElement>("legend-btn");
const closedPanelEl = requireEl<HTMLDivElement>("closed-panel");
const closedBtn = requireEl<HTMLDivElement>("closed-btn");
const ccActivityEl = requireEl<HTMLDivElement>("cc-activity");
const ccActivityText = requireEl<HTMLSpanElement>("cc-activity-text");
const ctxMenuEl = requireEl<HTMLDivElement>("ctx-menu");

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

  // Tracks the most recent Claude Code hook so the toolbar can surface
  // "which CC session is working in which repo right now." Session id is
  // the stable identifier CC assigns per conversation.
  lastCCActivity: {
    session_id: string;
    workspace_id: string;
    cwd: string;
    tool: string | null;
    timestamp: number;
  } | null;

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
  lastCCActivity: null,
  connection: "closed",
};

let viewport: ViewportState = {
  xMin: -10, xMax: 10, yMin: -10, yMax: 10,
  width: canvas.clientWidth, height: canvas.clientHeight,
};

let cursorPx = -1;
let cursorPy = -1;

// Cached attachment/height computation for the current frame. Refreshed
// at the top of renderAll so hit-test and downstream adapters see the
// same effective heights without recomputing.
let currentAttachments: NodeAttachments = { slots: new Map(), effectiveHeights: new Map() };

// Returns the app.nodes list with each node's height replaced by its
// cached effective height — matches what the user visually sees, so
// hit-tests and process-group bounding-box math stay aligned.
function effectiveCanvasNodes(): CanvasNode[] {
  return app.nodes.map((cn) => ({
    ...cn,
    height: currentAttachments.effectiveHeights.get(cn.id) ?? cn.height,
  }));
}

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

  // Effective height from the current attachment pass — auto-grows a
  // node upward when one of its sides has too many edges to fit. Authored
  // y stays at the bottom; the box just extends further up.
  const effectiveHeight = currentAttachments.effectiveHeights.get(cn.id) ?? cn.height;

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
    height: effectiveHeight,
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
// uses {src, dst}. Maps each CanvasEdgeKind to the legacy Edge kind name
// whose color slot we're using. Every kind now gets a distinct color —
// "custom" no longer collides with "imports".
function toRenderEdge(ce: CanvasEdge): Edge {
  const canvasKind = ce.kind ?? "custom";
  const legacyKind =
    canvasKind === "imports" ? "import"
    : canvasKind === "calls" ? "calls"
    : canvasKind === "reads" ? "type_only"
    : canvasKind === "writes" ? "dynamic_import"
    : canvasKind === "control" ? "side_effect"
    : "custom"; // CanvasEdgeKind "custom" gets its own palette entry
  const edge: Edge = {
    source: ce.src,
    target: ce.dst,
    kind: legacyKind,
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
  // Refresh the shared attachment/effective-height cache first. Every
  // downstream consumer (toRenderNode, hit-test, edge routing) reads
  // from it so they stay in sync within one frame.
  const attachmentNodes = app.nodes.map((cn) => ({
    id: cn.id, x: cn.x, y: cn.y, width: cn.width, height: cn.height,
  }) as unknown as NodeState);
  currentAttachments = computeNodeAttachments(attachmentNodes, app.edges.map(toRenderEdge));

  const renderNodes = app.nodes.map(toRenderNode);
  const renderEdges = app.edges.map(toRenderEdge);

  // Auto-grown heights mean the process-group bounding box math also
  // needs to see the taller nodes. Build a parallel node list with the
  // effective heights baked back into CanvasNode shape.
  const processNodes: CanvasNode[] = app.nodes.map((cn) => ({
    ...cn,
    height: currentAttachments.effectiveHeights.get(cn.id) ?? cn.height,
  }));

  // WebGL canvas just provides the cleared background now; all drawing
  // happens in the 2D overlay above it. Render with empty draws so the
  // WebGL clear color (matched to the page bg) still paints each frame.
  render(ctx, viewport, []);

  clearOverlay(overlay);
  const c2d = overlay.ctx;

  // Blueprint dot grid — anchored in data space so it pans/zooms with
  // the view, giving the canvas a proper drafting-surface feel.
  drawDotGrid(c2d);

  // Process groups next — subtle backdrop behind everything else.
  drawProcessGroups(c2d, viewport, processNodes);

  // Edges next so the node fills paint on top of them, which naturally
  // replaces the old clearRect node-mask trick: rounded nodes cover any
  // edge that routes through their rect.
  drawEdges2D(c2d, viewport, renderEdges, renderNodes, currentAttachments);

  // Nodes with rounded corners, language accent strip, halo, and border.
  drawNodes2D(c2d, viewport, renderNodes);

  drawStatusLine(c2d);
  drawNodeLabels(c2d);

  if (app.hoveredNodeId !== null) drawHoverTooltip(c2d);
  else if (app.hoveredEdgeId !== null) drawEdgeHoverTooltip(c2d);

  // Empty state is managed via the DOM overlay (#empty-state), which is
  // shown/hidden by updateEmptyState(). No draw here.
}

// Draws a data-space dot grid — dots at every GRID_SPACING_DATA units.
// Spacing adapts with zoom: if pixels-per-data-unit drops low, we step
// by 2x or 4x to avoid a visually dense wall of dots.
function drawDotGrid(c2d: CanvasRenderingContext2D): void {
  if (app.nodes.length === 0) return; // empty canvas — skip decoration

  const baseSpacing = 40;
  const pxPerUnitX = viewport.width / (viewport.xMax - viewport.xMin);
  const pxPerUnitY = viewport.height / (viewport.yMax - viewport.yMin);
  const pxPerUnit = Math.min(pxPerUnitX, pxPerUnitY);

  // Pick a spacing that renders between ~14 and ~56 pixels on screen.
  // Step by powers of 2 so zoom feels like snapping, not gradual density.
  let spacing = baseSpacing;
  while (spacing * pxPerUnit < 14) spacing *= 2;
  while (spacing * pxPerUnit > 56 && spacing > 4) spacing /= 2;

  const startX = Math.ceil(viewport.xMin / spacing) * spacing;
  const endX = viewport.xMax;
  const startY = Math.ceil(viewport.yMin / spacing) * spacing;
  const endY = viewport.yMax;

  c2d.save();
  c2d.fillStyle = "rgba(140, 200, 235, 0.09)";
  for (let x = startX; x <= endX; x += spacing) {
    for (let y = startY; y <= endY; y += spacing) {
      const { px, py } = dataToPixel(viewport, x, y);
      c2d.beginPath();
      c2d.arc(px, py, 1.1, 0, Math.PI * 2);
      c2d.fill();
    }
  }
  c2d.restore();
}

function drawStatusLine(c2d: CanvasRenderingContext2D): void {
  c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  c2d.fillStyle = "rgba(200, 200, 200, 0.6)";
  c2d.textAlign = "left";
  c2d.textBaseline = "top";
  const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId);
  const cvs = app.canvases.find((c) => c.id === app.activeCanvasId);
  // Daemon status surfaces only when something's wrong. The ● dot next
  // to "daemon" was purely decorative — it never changed in normal use.
  const parts: string[] = [];
  if (app.connection !== "open") parts.push("⚠ daemon disconnected");
  parts.push(`workspace: ${ws?.name ?? "(none)"}`);
  parts.push(`canvas: ${cvs?.name ?? "(none)"}`);
  parts.push(`${app.nodes.length} nodes`);
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
    // Size the label to fit comfortably inside the node box. Height sets
    // an upper bound (don't fill more than ~55% vertically), and we also
    // clamp against width so a short node with a long filename doesn't
    // get a huge font that just gets truncated. Hard cap at 13px keeps
    // the diagram feeling compact rather than blown-up.
    const byHeight = hPx * 0.55;
    const byWidth = Math.max(8, wPx / 7);
    const fontSize = Math.min(byHeight, byWidth, 13);
    // Fade the label as it shrinks toward illegibility — full alpha at 8px+,
    // linearly transparent between 4 and 8, fully skipped under 4. Keeps
    // labels from popping off as you zoom out; they dissolve smoothly.
    if (fontSize < 4) continue;
    const alpha = 0.95 * Math.min(1, Math.max(0, (fontSize - 4) / 4));
    c2d.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    c2d.fillStyle = `rgba(240, 240, 240, ${alpha.toFixed(3)})`;
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

function visibleCanvases(): Canvas[] {
  return app.canvases.filter((c) => !c.hidden);
}

function hiddenCanvases(): Canvas[] {
  return app.canvases.filter((c) => !!c.hidden);
}

function renderTabs(): void {
  tabbarEl.innerHTML = "";
  for (const cv of visibleCanvases()) {
    const chip = document.createElement("div");
    chip.className = "tab" + (cv.id === app.activeCanvasId ? " active" : "");
    chip.title = cv.description ?? "";

    const label = document.createElement("span");
    label.textContent = cv.name;
    chip.appendChild(label);

    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.title = "Close tab (reopen from the Closed menu)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeCanvas(cv.id);
    });
    chip.appendChild(close);

    chip.addEventListener("click", () => {
      if (cv.id === app.activeCanvasId) return;
      void switchCanvas(cv.id);
    });
    tabbarEl.appendChild(chip);
  }
  // + new only makes sense when a workspace is focused — without one,
  // there's no workspace to create a canvas in, so hide the chip. The
  // welcome panel's "Open a repo folder manually" button handles the
  // "get into a workspace" path instead.
  if (app.activeWorkspaceId) {
    const add = document.createElement("div");
    add.className = "new-canvas";
    add.textContent = "+ new";
    add.title = "Create a new canvas";
    add.addEventListener("click", () => {
      void createCanvasPrompt();
    });
    tabbarEl.appendChild(add);
  }

  // Toggle the "Closed" button based on whether there's anything to reopen.
  const hiddenCount = hiddenCanvases().length;
  closedBtn.style.display = hiddenCount > 0 ? "" : "none";
  closedBtn.textContent = `Closed (${hiddenCount})`;
}

async function closeCanvas(canvasId: string): Promise<void> {
  if (!app.activeWorkspaceId) return;
  // Optimistic: flip locally so the tab disappears immediately; the
  // canvas.updated event from the daemon will reconcile.
  const cv = app.canvases.find((c) => c.id === canvasId);
  if (cv) cv.hidden = true;

  // If the closed canvas was active, switch to another visible one.
  if (app.activeCanvasId === canvasId) {
    const fallback = visibleCanvases()[0];
    app.activeCanvasId = fallback ? fallback.id : null;
    app.nodes = [];
    app.edges = [];
    app.selectedNodeIds.clear();
    if (fallback) void switchCanvas(fallback.id);
  }
  renderTabs();
  updateEmptyState();
  requestFrame();

  try {
    await fetch(`${DAEMON_ORIGIN}/workspaces/${app.activeWorkspaceId}/canvases/${canvasId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: true }),
    });
  } catch {
    // If the PATCH fails, the daemon didn't persist hidden=true. Revert.
    if (cv) cv.hidden = false;
    renderTabs();
  }
}

async function reopenCanvas(canvasId: string): Promise<void> {
  if (!app.activeWorkspaceId) return;
  const cv = app.canvases.find((c) => c.id === canvasId);
  if (cv) cv.hidden = false;
  renderTabs();
  updateEmptyState();

  try {
    await fetch(`${DAEMON_ORIGIN}/workspaces/${app.activeWorkspaceId}/canvases/${canvasId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: false }),
    });
  } catch {
    if (cv) cv.hidden = true;
    renderTabs();
    return;
  }

  // Auto-switch into the reopened canvas so it's immediately usable.
  await switchCanvas(canvasId);
  setClosedPanelOpen(false);
}

// Three-mode empty state — first-run welcome, no-canvases prompt, or
// "Claude is authoring" hint when a canvas is empty and CC hooks are
// firing. Replaces the old "only show when workspace has zero canvases"
// behavior which left first-time users staring at a blank screen.
function updateEmptyState(): void {
  const mode = computeEmptyStateMode();
  if (mode === null) {
    emptyStateEl.style.display = "none";
    return;
  }
  emptyStatePanelEl.innerHTML = renderEmptyStateHTML(mode);
  emptyStateEl.style.display = "flex";
  // Mockup diagram appears only in onboarding modes. In authoring mode
  // CC is about to paint real nodes, so showing a fake diagram behind
  // them would be confusing.
  const mockupEl = document.getElementById("mockup-bg") as SVGElement | null;
  if (mockupEl) {
    const showMockup = mode.kind === "no-workspace" || mode.kind === "no-canvases";
    mockupEl.style.display = showMockup ? "block" : "none";
  }
  // If the panel has an inline "Create blank canvas" button (no-canvases
  // mode), wire it directly — avoids sending the user to hunt for the
  // smaller `+ new` chip in the tab bar.
  const welcomeNewBtn = document.getElementById("welcome-new-canvas");
  if (welcomeNewBtn) {
    welcomeNewBtn.addEventListener("click", () => {
      emptyStateEl.style.display = "none";
      createCanvasPrompt();
    });
  }
}

type EmptyStateMode =
  | { kind: "no-workspace" }
  | { kind: "no-canvases"; workspaceName: string }
  | { kind: "authoring"; workspaceName: string; canvasName: string; tool?: string; target?: string };

function computeEmptyStateMode(): EmptyStateMode | null {
  // No workspace focused — fresh install, first run, or all workspaces
  // paused. Show the top-level welcome with first-prompt suggestion.
  if (!app.activeWorkspaceId) return { kind: "no-workspace" };

  const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId);
  const wsName = ws?.name ?? "this workspace";

  // Workspace focused but no canvases exist — "ask Claude to diagram" hint.
  if (app.canvases.length === 0) {
    return { kind: "no-canvases", workspaceName: wsName };
  }

  // Canvas active but empty + CC is touching files in this workspace right
  // now. Tells the user "yes it's working, Claude is still reading/thinking"
  // instead of silently staring at an empty canvas for minutes.
  const activeCanvas = app.canvases.find((c) => c.id === app.activeCanvasId);
  if (activeCanvas && app.nodes.length === 0) {
    const act = app.lastCCActivity;
    const freshness = act ? Date.now() - act.timestamp : Infinity;
    if (act && freshness < 30_000 && act.workspace_id === app.activeWorkspaceId) {
      const target = act.cwd && act.cwd !== "" ? shortenTarget(act, ws?.root) : undefined;
      return {
        kind: "authoring",
        workspaceName: wsName,
        canvasName: activeCanvas.name,
        ...(act.tool ? { tool: act.tool } : {}),
        ...(target ? { target } : {}),
      };
    }
  }

  return null;
}

// Extract a workspace-relative target path from a hook payload for display.
// The payload's `cwd` is the session's cwd; the actual file being touched
// lives in `tool` land — but we don't have the file_path here, only the
// tool name + cwd. Skip target rendering; showing the tool alone is enough.
function shortenTarget(_act: { cwd: string }, _root?: string): string | undefined {
  return undefined;
}

const WHAT_IS_SCHEMATIC = `
  <p class="what-is">
    Schematic is a drafting canvas for your codebase. Claude reads the code,
    places files as boxes, and connects them with labeled wires showing how
    they relate. Each canvas is a focused view — one subsystem at a time,
    authored by Claude, edited live as you work.
  </p>
`;

function renderEmptyStateHTML(mode: EmptyStateMode): string {
  if (mode.kind === "no-workspace") {
    return `
      <h1>Schematic</h1>
      <p class="tagline">Claude Code draws architecture diagrams of your repo.</p>
      ${WHAT_IS_SCHEMATIC}
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          Open a <strong>new</strong> Claude Code session in your repo's folder.
          <div class="note">Already-open sessions can't use Schematic until restarted — MCP tools load at session start.</div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">Say: <code>open this repo in schematic</code></div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">Say: <code>diagram the architecture</code></div>
      </div>
    `;
  }
  if (mode.kind === "no-canvases") {
    return `
      <h1>${escapeHtml(mode.workspaceName)}</h1>
      <p class="tagline">Workspace is open — no diagrams yet.</p>
      ${WHAT_IS_SCHEMATIC}
      <div class="step">
        <div class="step-num">→</div>
        <div class="step-body">
          In a Claude Code session, say something like
          <code>diagram the auth flow</code> or
          <code>map how the frontend connects to the engine</code>.
          <div class="note">If Claude says it doesn't have Schematic tools, restart the session.</div>
        </div>
      </div>
      <button class="welcome-action" id="welcome-new-canvas">
        + Create blank canvas
      </button>
    `;
  }
  // authoring
  const toolLine = mode.tool
    ? `<span>Last tool: <code>${escapeHtml(mode.tool)}</code></span>`
    : `<span>Claude is reading files…</span>`;
  return `
    <h1>${escapeHtml(mode.canvasName)}</h1>
    <p class="tagline">Canvas created — Claude is authoring.</p>
    <div class="step">
      <div class="step-num">→</div>
      <div class="step-body">Nodes appear on this canvas as Claude adds them. Reading files first takes a moment on a large repo.</div>
    </div>
    <div class="authoring">
      <span class="dot"></span>
      ${toolLine}
    </div>
  `;
}

// --- Legend (dropdown from the toolbar) --------------------------------

let legendOpen = false;

function renderLegend(): void {
  const edgeRows = LEGEND_EDGE_KINDS
    .map((e) => `
      <div class="row edge-row">
        <span class="swatch line" style="background:${e.color}"></span>
        <div class="edge-row-text">
          <span class="edge-label">${e.label}</span>
          <span class="edge-hint">${e.hint}</span>
        </div>
      </div>`)
    .join("");
  const langRows = LEGEND_LANGUAGES
    .map((l) => `
      <div class="row">
        <span class="swatch" style="background:${l.color}"></span>
        <span>${l.label}</span>
      </div>`)
    .join("");
  const haloRows = LEGEND_HALO
    .map((h) => `
      <div class="row">
        <span class="swatch halo" style="background:${h.color}"></span>
        <span>${h.label}</span>
      </div>`)
    .join("");

  legendEl.innerHTML = `
    <section>
      <h4>Edges</h4>
      ${edgeRows}
    </section>
    <section>
      <h4>Language accent</h4>
      ${langRows}
    </section>
    <section>
      <h4>Activity halos</h4>
      ${haloRows}
    </section>
    <div class="attribution">
      Schematic · Angelco · <a href="https://angelco.tech" target="_blank" rel="noopener">angelco.tech</a>
    </div>`;
}

function setLegendOpen(open: boolean): void {
  legendOpen = open;
  legendEl.style.display = open ? "block" : "none";
  legendBtn.classList.toggle("open", open);
  if (open) setClosedPanelOpen(false);
}

legendBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setLegendOpen(!legendOpen);
});

renderLegend();

// --- Closed (reopen-tab) menu ------------------------------------------

let closedPanelOpen = false;

function renderClosedPanel(): void {
  const hidden = hiddenCanvases();
  if (hidden.length === 0) {
    closedPanelEl.innerHTML = `<div class="empty">No closed tabs.</div>`;
    return;
  }
  // Most-recently-updated first — intuitive for "recently closed" even
  // though we store closed state as a flag rather than a timestamp.
  const sorted = [...hidden].sort((a, b) => b.updated_at - a.updated_at);
  closedPanelEl.innerHTML = sorted
    .map((c) => `
      <div class="item" data-cid="${c.id}">
        <span>${escapeHtml(c.name)}</span>
        <span class="right">
          <span class="reopen">reopen</span>
          <span class="delete-btn" data-cid-delete="${c.id}" title="Delete permanently">×</span>
        </span>
      </div>`)
    .join("");
  for (const el of closedPanelEl.querySelectorAll<HTMLDivElement>(".item")) {
    const cid = el.getAttribute("data-cid");
    if (!cid) continue;
    el.addEventListener("click", (e) => {
      // If the click landed on the delete button, skip the reopen handler.
      const target = e.target as HTMLElement;
      if (target.classList.contains("delete-btn")) return;
      void reopenCanvas(cid);
    });
  }
  for (const delEl of closedPanelEl.querySelectorAll<HTMLSpanElement>(".delete-btn")) {
    const cid = delEl.getAttribute("data-cid-delete");
    if (!cid) continue;
    delEl.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteCanvas(cid);
    });
  }
}

async function deleteCanvas(canvasId: string): Promise<void> {
  if (!app.activeWorkspaceId) return;
  const cv = app.canvases.find((c) => c.id === canvasId);
  if (!cv) return;
  const ok = window.confirm(
    `Delete "${cv.name}" permanently? This removes the canvas and all its nodes and edges. Can't be undone.`,
  );
  if (!ok) return;

  try {
    const r = await fetch(
      `${DAEMON_ORIGIN}/workspaces/${app.activeWorkspaceId}/canvases/${canvasId}`,
      { method: "DELETE" },
    );
    if (!r.ok) {
      showToast("Delete failed.");
      return;
    }
  } catch {
    showToast("Delete failed (network error).");
    return;
  }

  // Canvas.deleted event from the daemon will also fire and run its own
  // handler, but removing locally here keeps the Closed panel responsive.
  app.canvases = app.canvases.filter((c) => c.id !== canvasId);
  renderClosedPanel();
  renderTabs();
  updateEmptyState();
  showToast(`Deleted "${cv.name}".`);
}

function setClosedPanelOpen(open: boolean): void {
  closedPanelOpen = open;
  if (open) renderClosedPanel();
  closedPanelEl.style.display = open ? "block" : "none";
  closedBtn.classList.toggle("open", open);
  if (open) setLegendOpen(false);
}

closedBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setClosedPanelOpen(!closedPanelOpen);
});

// Document-level click handler dismisses whichever dropdown is open when
// the click lands outside both.
document.addEventListener("click", (e) => {
  const target = e.target as Node;
  if (legendOpen && !legendEl.contains(target) && !legendBtn.contains(target)) {
    setLegendOpen(false);
  }
  if (closedPanelOpen && !closedPanelEl.contains(target) && !closedBtn.contains(target)) {
    setClosedPanelOpen(false);
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- CC activity indicator --------------------------------------------
// Freshness thresholds. Under 15s = live ("CC is active right now"),
// under 2min = stale ("session is open but idle"), older = idle.
const CC_FRESH_MS = 15_000;
const CC_STALE_MS = 120_000;

function renderCCActivity(): void {
  const a = app.lastCCActivity;
  if (!a) {
    ccActivityEl.style.display = "none";
    return;
  }
  const ws = app.workspaces.find((w) => w.id === a.workspace_id);
  const wsName = ws?.name ?? "(unknown repo)";
  const shortSession = a.session_id.slice(0, 8);

  const age = Date.now() - a.timestamp;
  ccActivityEl.classList.remove("stale", "idle");
  if (age > CC_STALE_MS) ccActivityEl.classList.add("idle");
  else if (age > CC_FRESH_MS) ccActivityEl.classList.add("stale");

  ccActivityText.textContent = `CC: ${wsName}`;
  ccActivityEl.title =
    `CC session ${shortSession}…\n` +
    `Repo: ${wsName}\n` +
    `cwd: ${a.cwd}\n` +
    (a.tool ? `Last tool: ${a.tool}\n` : "") +
    `Last hook: ${new Date(a.timestamp).toLocaleTimeString()}`;
  ccActivityEl.style.display = "flex";
}

// Re-render every second so the fresh/stale/idle dot reflects real time
// even when no new hooks arrive. Cheap — just toggles a class and updates
// the tooltip string; no render loop involved.
window.setInterval(() => {
  renderCCActivity();
  // Also refresh the empty state — when Claude stops firing hooks, the
  // "authoring" panel should fall back to the regular "no-canvases" view.
  updateEmptyState();
}, 1000);

// --- Context menu (right-click) ---------------------------------------
// Runs pre-fetched Schematic queries and copies a Claude-ready prompt to
// the clipboard — the user pastes into whichever CC session they want to
// answer. Paste (rather than auto-inject) is deliberate: with multiple CC
// sessions open, auto-injecting into "the next session that prompts" is
// a minefield. Explicit paste = deterministic delivery.

interface CtxMenuItem {
  label: string;
  hint?: string;
  action: () => Promise<void> | void;
}

function renderCtxMenu(x: number, y: number, header: string, items: CtxMenuItem[]): void {
  const parts: string[] = [];
  parts.push(`<div class="header">${escapeHtml(header)}</div>`);
  for (const it of items) {
    parts.push(`
      <div class="item">
        <span>${escapeHtml(it.label)}</span>
        ${it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : ""}
      </div>`);
  }
  ctxMenuEl.innerHTML = parts.join("");
  // Wire clicks after innerHTML overwrites.
  const itemEls = ctxMenuEl.querySelectorAll<HTMLDivElement>(".item");
  items.forEach((it, i) => {
    const el = itemEls[i];
    if (!el) return;
    el.addEventListener("click", () => {
      closeCtxMenu();
      void Promise.resolve(it.action()).catch((e) => {
        console.error("[schematic] context-menu action failed:", e);
        showToast("Action failed. Check the console.");
      });
    });
  });

  // Position, then nudge back on-screen if off the right/bottom edge.
  ctxMenuEl.style.left = `${x}px`;
  ctxMenuEl.style.top = `${y}px`;
  ctxMenuEl.style.display = "block";
  const r = ctxMenuEl.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) {
    ctxMenuEl.style.left = `${window.innerWidth - r.width - 4}px`;
  }
  if (r.bottom > window.innerHeight - 4) {
    ctxMenuEl.style.top = `${window.innerHeight - r.height - 4}px`;
  }
}

function closeCtxMenu(): void {
  ctxMenuEl.style.display = "none";
}

document.addEventListener("click", (e) => {
  if (ctxMenuEl.style.display === "none") return;
  if (ctxMenuEl.contains(e.target as Node)) return;
  closeCtxMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCtxMenu();
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const hitNode = hitTestVisible(px, py);
  if (hitNode) {
    openNodeMenu(e.clientX, e.clientY, hitNode);
    return;
  }
  const hitGroup = hitTestProcessGroup(overlay.ctx, viewport, effectiveCanvasNodes(), px, py);
  if (hitGroup) {
    openProcessMenu(e.clientX, e.clientY, hitGroup.process, hitGroup.memberIds);
    return;
  }
  openCanvasMenu(e.clientX, e.clientY);
});

// --- Node right-click --------------------------------------------------

function openNodeMenu(x: number, y: number, node: CanvasNode): void {
  const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId);
  if (!ws) return;
  const shortPath = node.file_path.slice(node.file_path.lastIndexOf("/") + 1);
  renderCtxMenu(x, y, shortPath, [
    {
      label: "Copy 'Blast radius' prompt",
      hint: "impact",
      action: () => runBlastRadius(ws.id, node),
    },
    {
      label: "Copy 'Explain this file' prompt",
      hint: "explain",
      action: () => runExplainFile(node),
    },
    {
      label: "Create canvas centered on this file",
      hint: "new canvas",
      action: () => runCreateCanvasForNode(ws.id, node),
    },
  ]);
}

async function runBlastRadius(workspaceId: string, node: CanvasNode): Promise<void> {
  const report = await fetchJSON<unknown>(
    `/workspaces/${workspaceId}/impact?file_path=${encodeURIComponent(node.file_path)}`,
  );
  const prompt = [
    `The user wants to understand the blast radius of modifying this file before making changes.`,
    ``,
    `File: ${node.file_path}`,
    ``,
    `Schematic has pre-computed the impact report across every canvas in this workspace:`,
    ``,
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    ``,
    `Based on this data, summarize:`,
    `1. What each instance's role is (which canvas, which process)`,
    `2. What files are directly connected (incoming + outgoing)`,
    `3. What would be at risk if this file changed`,
    `4. Whether it's a high-degree hub that warrants extra care`,
    ``,
    `Then ask the user what change they want to make.`,
  ].join("\n");
  await copyPromptAndToast(prompt, "Blast radius prompt copied.");
}

async function runCreateCanvasForNode(workspaceId: string, node: CanvasNode): Promise<void> {
  const baseName = node.file_path.slice(node.file_path.lastIndexOf("/") + 1);
  const canvasName = `${baseName} — connections`;
  const report = await fetchJSON<unknown>(
    `/workspaces/${workspaceId}/impact?file_path=${encodeURIComponent(node.file_path)}`,
  );
  const prompt = [
    `Populate the Schematic canvas I just created, centered on a single file.`,
    ``,
    `Canvas id: <CANVAS_ID>`,
    `Center file: ${node.file_path}`,
    ``,
    `Schematic pre-fetched the impact report (every canvas instance of this file and what it connects to):`,
    ``,
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    ``,
    `Steps:`,
    `1. Add a node for ${node.file_path} near the center (x ~0, y ~0).`,
    `2. Read the file to verify its real dependencies and dependents.`,
    `3. Add nodes for the files it actually connects to. Use the JSON as a starting hint, but trust the code.`,
    `4. Arrange spatially: incoming dependents to the left of the center, outgoing targets to the right.`,
    `5. Add edges with short relationship labels ("loads", "authenticates via", "writes to").`,
    `6. Group files with the \`process\` argument if natural clusters emerge.`,
    ``,
    `If this file turns out to have trivial connections (one or two imports, a simple utility with no architectural role), say so and suggest the user delete this empty canvas via the Closed tabs menu instead of populating it.`,
  ].join("\n");
  await createCanvasWithPrompt(
    workspaceId,
    canvasName,
    `Centered on ${node.file_path}`,
    prompt,
    "Canvas created. Prompt copied.",
  );
}

async function runExplainFile(node: CanvasNode): Promise<void> {
  const prompt = [
    `The user wants you to explain this file.`,
    ``,
    `File: ${node.file_path}`,
    node.process ? `Process: ${node.process}` : "",
    ``,
    `Read the file, then summarize:`,
    `1. What it does`,
    `2. What it exports and to whom`,
    `3. What it depends on`,
    `4. Any notable invariants or gotchas you notice`,
  ].filter(Boolean).join("\n");
  await copyPromptAndToast(prompt, "Explain prompt copied.");
}

// --- Process container right-click -------------------------------------

function openProcessMenu(x: number, y: number, process: string, memberIds: string[]): void {
  const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId);
  if (!ws) return;
  renderCtxMenu(x, y, `process: ${process}`, [
    {
      label: "Copy 'Audit this group' prompt",
      hint: "audit",
      action: () => runAuditProcess(ws.id, process, memberIds),
    },
    {
      label: "Extract this process to its own canvas",
      hint: "new canvas",
      action: () => runExtractProcess(ws.id, process, memberIds),
    },
  ]);
}

async function runExtractProcess(
  workspaceId: string, process: string, memberIds: string[],
): Promise<void> {
  const memberFiles = memberIds
    .map((id) => app.nodes.find((n) => n.id === id)?.file_path)
    .filter((fp): fp is string => typeof fp === "string");
  const canvasName = `${process}`;
  const prompt = [
    `Populate the Schematic canvas I just created — a focused view of the "${process}" process.`,
    ``,
    `Canvas id: <CANVAS_ID>`,
    `Process: ${process}`,
    ``,
    `Members (from the source canvas):`,
    ...memberFiles.map((f) => `- ${f}`),
    ``,
    `Steps:`,
    `1. Add a node for each member file above. Tag each with \`process: "${process}"\` so they render grouped.`,
    `2. Read each file to understand how they actually work together.`,
    `3. Add edges for the internal relationships that make this process cohesive — use short labels ("invokes", "reads", "writes to").`,
    `4. Arrange spatially by data flow (inputs on the left, outputs on the right).`,
    `5. If any of these files connect strongly to files OUTSIDE this process, also add those external files as reference nodes (no process label) and draw the boundary edges. Gives the user the context of how this process talks to the rest of the system.`,
    ``,
    `If the member list is a grab-bag of unrelated files with no real internal wiring, say so — don't force edges that aren't in the code.`,
  ].join("\n");
  await createCanvasWithPrompt(
    workspaceId,
    canvasName,
    `Extracted from process "${process}"`,
    prompt,
    "Canvas created. Prompt copied.",
  );
}

async function runAuditProcess(
  workspaceId: string, process: string, memberIds: string[],
): Promise<void> {
  if (!app.activeCanvasId) return;
  const raw = await fetchJSON<{
    canvas_name: string;
    missing: Array<{ node_id: string; file_path: string }>;
    existing: Array<{ node_id: string; file_path: string }>;
    duplicates: Array<{ file_path: string; node_ids: string[] }>;
  }>(
    `/workspaces/${workspaceId}/canvases/${app.activeCanvasId}/audit`,
  );
  const memberSet = new Set(memberIds);
  // Filter audit to the process's member set so CC sees only the group.
  const filtered = {
    canvas_name: raw.canvas_name,
    process,
    missing: raw.missing.filter((m) => memberSet.has(m.node_id)),
    existing: raw.existing.filter((e) => memberSet.has(e.node_id)),
    duplicates: raw.duplicates
      .map((d) => ({
        file_path: d.file_path,
        node_ids: d.node_ids.filter((id) => memberSet.has(id)),
      }))
      .filter((d) => d.node_ids.length > 1),
  };
  const prompt = [
    `The user wants to audit the "${process}" process group on the "${raw.canvas_name}" canvas.`,
    ``,
    `Here's the drift report, filtered to that process's member nodes:`,
    ``,
    "```json",
    JSON.stringify(filtered, null, 2),
    "```",
    ``,
    `Summarize what's healthy, what's stale (files missing from disk), and any duplicate file instances worth flagging. Propose fixes if any nodes should be removed, renamed, or rewired.`,
  ].join("\n");
  await copyPromptAndToast(prompt, "Group audit prompt copied.");
}

// --- Empty-canvas right-click ------------------------------------------

function openCanvasMenu(x: number, y: number): void {
  const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId);
  const cv = app.canvases.find((c) => c.id === app.activeCanvasId);
  if (!ws || !cv) return;
  renderCtxMenu(x, y, `canvas: ${cv.name}`, [
    {
      label: "Copy 'Audit canvas' prompt",
      hint: "drift",
      action: () => runAuditCanvas(ws.id, cv.id, cv.name),
    },
    {
      label: "Copy 'Find hubs' prompt",
      hint: "keystones",
      action: () => runFindHubs(ws.id, cv.id, cv.name),
    },
    {
      label: "Copy 'Find orphans' prompt",
      hint: "cleanup",
      action: () => runFindOrphans(ws.id, cv.id, cv.name),
    },
    {
      label: "Copy 'Find cycles' prompt",
      hint: "smells",
      action: () => runFindCycles(ws.id, cv.id, cv.name),
    },
  ]);
}

async function runAuditCanvas(wid: string, cid: string, cname: string): Promise<void> {
  const report = await fetchJSON<unknown>(`/workspaces/${wid}/canvases/${cid}/audit`);
  const prompt = [
    `The user wants a drift audit of the "${cname}" Schematic canvas.`,
    ``,
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    ``,
    `Summarize health: node count, stale count (missing from disk), duplicates. If anything looks wrong, propose fixes.`,
  ].join("\n");
  await copyPromptAndToast(prompt, "Canvas audit prompt copied.");
}

async function runFindHubs(wid: string, cid: string, cname: string): Promise<void> {
  const report = await fetchJSON<unknown>(`/workspaces/${wid}/canvases/${cid}/hubs?min_degree=2`);
  const prompt = [
    `The user wants to identify the keystone files on the "${cname}" canvas — high-degree nodes that warrant care when refactoring.`,
    ``,
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    ``,
    `Rank the hubs by total degree, briefly explain what role each plays (read the file if helpful), and flag any that look architecturally risky (e.g. one file doing too many roles).`,
  ].join("\n");
  await copyPromptAndToast(prompt, "Hubs prompt copied.");
}

async function runFindOrphans(wid: string, cid: string, cname: string): Promise<void> {
  const report = await fetchJSON<unknown>(`/workspaces/${wid}/canvases/${cid}/orphans`);
  const prompt = [
    `The user wants to clean up orphan nodes (zero edges) on the "${cname}" canvas.`,
    ``,
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    ``,
    `For each orphan, read the file and decide: is this a forgotten dependency that should be wired up, or a placeholder that can be removed? Propose specific edges to add (add_edge) or nodes to delete (delete_node). Ask the user to confirm before making changes.`,
  ].join("\n");
  await copyPromptAndToast(prompt, "Orphans prompt copied.");
}

async function runFindCycles(wid: string, cid: string, cname: string): Promise<void> {
  const report = await fetchJSON<unknown>(`/workspaces/${wid}/canvases/${cid}/cycles`);
  const prompt = [
    `The user wants to know if the "${cname}" canvas has circular dependencies.`,
    ``,
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    ``,
    `For each cycle found (if any), explain what it means in plain terms and suggest which edge to break — i.e. which file should own the relationship, and which dependency is more naturally the other way around. If no cycles, confirm that and move on.`,
  ].join("\n");
  await copyPromptAndToast(prompt, "Cycles prompt copied.");
}

// --- Shared: prompt modal ----------------------------------------------
// Every prompt-copy action lands here. Single deterministic path: the
// prompt opens in a modal with the text pre-selected and a Copy button
// that calls clipboard. No silent clipboard write, no try/catch branch
// — the user always sees the same thing regardless of browser clipboard
// behavior, and they can always select-copy manually if Copy fails.

const promptModalEl = document.getElementById("prompt-modal") as HTMLDivElement | null;
const promptModalText = document.getElementById("prompt-modal-text") as HTMLTextAreaElement | null;
const promptModalCopy = document.getElementById("prompt-modal-copy") as HTMLButtonElement | null;
const promptModalClose = document.getElementById("prompt-modal-close") as HTMLButtonElement | null;

async function copyPromptAndToast(prompt: string, label: string): Promise<void> {
  if (!promptModalEl || !promptModalText) return;
  promptModalText.value = prompt;
  promptModalEl.dataset.label = label;
  promptModalEl.style.display = "flex";
  promptModalText.focus();
  promptModalText.select();
}

promptModalCopy?.addEventListener("click", async () => {
  if (!promptModalText) return;
  await navigator.clipboard.writeText(promptModalText.value);
  const label = promptModalEl?.dataset.label ?? "Prompt copied.";
  if (promptModalEl) promptModalEl.style.display = "none";
  showToast(`${label} Paste into Claude Code.`);
});
promptModalClose?.addEventListener("click", () => {
  if (promptModalEl) promptModalEl.style.display = "none";
});
promptModalEl?.addEventListener("click", (e) => {
  if (e.target === promptModalEl && promptModalEl) {
    promptModalEl.style.display = "none";
  }
});

// Creates a new canvas on the server, builds a prompt referencing it,
// copies to clipboard, and switches the view to it. Prompts use the
// literal string "<CANVAS_ID>" as a placeholder which is replaced with
// the real id after creation — so the prompt body can be built before
// the canvas exists.
async function createCanvasWithPrompt(
  workspaceId: string,
  canvasName: string,
  description: string | undefined,
  promptTemplate: string,
  toastLabel: string,
): Promise<void> {
  const body: { name: string; description?: string } = { name: canvasName };
  if (description) body.description = description;
  const r = await fetch(
    `${DAEMON_ORIGIN}/workspaces/${workspaceId}/canvases`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    showToast("Canvas creation failed.");
    return;
  }
  const file = (await r.json()) as { canvas: Canvas };
  const prompt = promptTemplate.replace("<CANVAS_ID>", file.canvas.id);
  await copyPromptAndToast(prompt, toastLabel);
  await switchCanvas(file.canvas.id);
}

// --- Create-canvas modal ------------------------------------------------
// Replaces the old window.prompt. Collects a canvas name + a description
// of what the user wants to see mapped, creates the canvas, and copies a
// Schematic-optimized prompt to the clipboard for the user to paste into
// Claude Code. CC then authors the canvas using the MCP tools.

const createModal = requireEl<HTMLDivElement>("create-modal");
const createName = requireEl<HTMLInputElement>("create-name");
const createDesc = requireEl<HTMLTextAreaElement>("create-desc");
const createCancelBtn = requireEl<HTMLButtonElement>("create-cancel");
const createSubmitBtn = requireEl<HTMLButtonElement>("create-submit");
const toastEl = requireEl<HTMLDivElement>("toast");

let toastTimer: number | null = null;
function showToast(message: string, durationMs = 4000): void {
  toastEl.textContent = message;
  toastEl.style.display = "block";
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.style.display = "none";
    toastTimer = null;
  }, durationMs);
}

function openCreateModal(): void {
  createName.value = "";
  createDesc.value = "";
  createModal.style.display = "flex";
  createName.focus();
}

function closeCreateModal(): void {
  createModal.style.display = "none";
}

createCancelBtn.addEventListener("click", closeCreateModal);
createModal.addEventListener("click", (e) => {
  // Click on the backdrop (not the panel) dismisses.
  if (e.target === createModal) closeCreateModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && createModal.style.display !== "none") closeCreateModal();
});
createSubmitBtn.addEventListener("click", () => void submitCreateModal());

function createCanvasPrompt(): void {
  if (!app.activeWorkspaceId) return;
  openCreateModal();
}

function buildAuthoringPrompt(
  canvasName: string,
  canvasId: string,
  description: string,
): string {
  const trimmed = description.trim();
  const task = trimmed.length > 0
    ? `What to map: ${trimmed}`
    : `(no description provided)`;
  return [
    `Please populate the Schematic canvas I just created.`,
    ``,
    `Canvas: "${canvasName}" (id: ${canvasId})`,
    task,
    ``,
    `Read the relevant files first, then use the Schematic MCP tools to author the diagram:`,
    `- add_node(canvas_id, file_path, x, y, process?) for each file that belongs on the diagram`,
    `- add_edge(canvas_id, src, dst, label?, kind?) for each relationship`,
    ``,
    `Layout: arrange by data flow (inputs on the left, outputs on the right). Group related files with the \`process\` argument. Don't stack files vertically in one column.`,
    ``,
    `Edges: label each relationship in a few words (e.g. "loads buffers", "authenticates via"). Kind is one of: calls, imports, reads, writes, control, custom.`,
  ].join("\n");
}

async function submitCreateModal(): Promise<void> {
  if (!app.activeWorkspaceId) return;
  const name = createName.value.trim();
  const description = createDesc.value.trim();
  if (name.length === 0) {
    createName.focus();
    return;
  }

  createSubmitBtn.disabled = true;
  try {
    const body: { name: string; description?: string } = { name };
    if (description) body.description = description;
    const r = await fetch(
      `${DAEMON_ORIGIN}/workspaces/${app.activeWorkspaceId}/canvases`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      console.error("[schematic] create canvas failed:", r.status);
      showToast("Canvas creation failed.");
      return;
    }
    const file = (await r.json()) as { canvas: Canvas };

    // Build + copy the curated prompt. Clipboard requires a user gesture,
    // which we have (the submit click).
    const prompt = buildAuthoringPrompt(file.canvas.name, file.canvas.id, description);
    try {
      await navigator.clipboard.writeText(prompt);
      showToast("Prompt copied. Paste into Claude Code to build the canvas.");
    } catch {
      // Clipboard write failed — show the prompt inline so user can grab it.
      showToast("Created. Clipboard blocked; open the console to copy the prompt.");
      console.log("[schematic] canvas prompt:\n" + prompt);
    }

    closeCreateModal();
    await switchCanvas(file.canvas.id);
  } finally {
    createSubmitBtn.disabled = false;
  }
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
    // Pick the most-recently-updated visible canvas as the initial. Tab
    // order stays in creation order for stability, but on refresh the
    // user lands on what they were last working on — not the first tab.
    // Hidden canvases live in the Closed menu and are excluded.
    const initial = [...visibleCanvases()].sort(
      (a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0),
    )[0];
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

// Refresh only the nodes/edges of the currently-active canvas. Unlike
// switchCanvas this preserves the user's viewport, selection, and
// active-canvas id — used when CC is authoring and the daemon fires
// canvas.content_changed events. Debounced so a burst of 20 add_node
// calls triggers one re-fetch instead of 20.
let canvasRefreshTimer: number | null = null;
function scheduleCanvasRefresh(canvasId: string): void {
  if (canvasRefreshTimer !== null) clearTimeout(canvasRefreshTimer);
  canvasRefreshTimer = window.setTimeout(() => {
    canvasRefreshTimer = null;
    void refreshCanvasContent(canvasId);
  }, 200);
}

async function refreshCanvasContent(canvasId: string): Promise<void> {
  if (!app.activeWorkspaceId || app.activeCanvasId !== canvasId) return;
  const file = await fetchJSON<{ canvas: Canvas; nodes: CanvasNode[]; edges: CanvasEdge[] }>(
    `/workspaces/${app.activeWorkspaceId}/canvases/${canvasId}`,
  );
  // Only replace content — keep viewport, selection, hover state.
  app.nodes = file.nodes;
  app.edges = file.edges;
  // Drop any stale selected ids that no longer exist on the canvas.
  const liveIds = new Set(file.nodes.map((n) => n.id));
  for (const id of Array.from(app.selectedNodeIds)) {
    if (!liveIds.has(id)) app.selectedNodeIds.delete(id);
  }
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
    drag = beginNodeDrag(nodeIds, px, py);
    canvas.style.cursor = "grabbing";
  } else {
    // No node under the cursor — try a process group. A hit on the group's
    // border ring or header pill drags every member together. The interior
    // of the group falls through so overlapping groups stay reachable.
    const groupHit = hitTestProcessGroup(overlay.ctx, viewport, effectiveCanvasNodes(), px, py);
    if (groupHit) {
      drag = beginNodeDrag(groupHit.memberIds, px, py);
      canvas.style.cursor = "grabbing";
    } else {
      drag = { kind: "viewport" };
    }
  }
});

function beginNodeDrag(
  nodeIds: string[], px: number, py: number,
): Extract<DragMode, { kind: "node" }> {
  const startPositions = new Map<string, { x: number; y: number }>();
  for (const id of nodeIds) {
    const n = app.nodes.find((nn) => nn.id === id);
    if (n) startPositions.set(id, { x: n.x, y: n.y });
  }
  const { x: dx0, y: dy0 } = pixelToData(viewport, px, py);
  return {
    kind: "node",
    nodeIds,
    startPositions,
    startDataX: dx0,
    startDataY: dy0,
  };
}

window.addEventListener("mouseup", (e) => {
  if (!drag) return;
  const wasNodeDrag = drag.kind === "node" ? drag : null;
  drag = null;
  canvas.style.cursor = "default";
  if (!didDrag) {
    // Click without drag = selection toggle. Selection exists only to let
    // the user pick multiple nodes and drag them together — every click on
    // a node toggles it in/out of the set, and clicking empty space clears.
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = hitTestVisible(px, py);
    if (hit) {
      if (app.selectedNodeIds.has(hit.id)) app.selectedNodeIds.delete(hit.id);
      else app.selectedNodeIds.add(hit.id);
    } else {
      app.selectedNodeIds.clear();
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
      const hit = hitTestEdge(viewport, renderEdges, renderNodes, currentAttachments, cursorPx, cursorPy);
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
  // zoom() expects (vp, centerX, centerY, factor) with centers in data
  // space. cursorPx/Py are pixel coords — convert each tick so the zoom
  // anchors under the cursor as the viewport changes.
  while (zoomAccum > ZOOM_THRESHOLD) {
    const { x: cx, y: cy } = pixelToData(viewport, cursorPx, cursorPy);
    viewport = zoom(viewport, cx, cy, 1 / ZOOM_STEP_FACTOR);
    zoomAccum -= ZOOM_THRESHOLD;
  }
  while (zoomAccum < -ZOOM_THRESHOLD) {
    const { x: cx, y: cy } = pixelToData(viewport, cursorPx, cursorPy);
    viewport = zoom(viewport, cx, cy, ZOOM_STEP_FACTOR);
    zoomAccum += ZOOM_THRESHOLD;
  }
  requestFrame();
}, { passive: false });

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  app.workspaces = await fetchJSON<Workspace[]>("/workspaces");

  // `?welcome` forces the onboarding view regardless of what the daemon
  // has focused. Useful for demos, screenshots, and verifying the empty
  // state without pausing workspaces server-side.
  const params = new URLSearchParams(window.location.search);
  const forceWelcome = params.has("welcome");

  // Precedence: ?welcome (force no-workspace), then ?w=<id>, then daemon
  // /focus, then first active.
  const urlParam = params.get("w");
  const focusResp = forceWelcome || urlParam
    ? null
    : await fetchJSON<{ workspace_id: string | null }>("/focus").catch(() => null);
  const focused = focusResp?.workspace_id ?? null;
  const chosen = forceWelcome
    ? null
    : (urlParam && app.workspaces.find((w) => w.id === urlParam)) ??
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
      if (event.type === "canvas.content_changed") {
        if (event.workspace_id !== app.activeWorkspaceId) return;
        if (event.canvas_id !== app.activeCanvasId) return;
        scheduleCanvasRefresh(event.canvas_id);
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
      if (event.type === "hook.received") {
        // Global broadcast — fires for CC activity in ANY workspace, even
        // one this browser isn't currently viewing. The indicator tells
        // the user which repo CC is actually working in.
        app.lastCCActivity = {
          session_id: event.payload.session_id,
          workspace_id: event.workspace_id,
          cwd: event.payload.cwd,
          tool: event.payload.tool,
          timestamp: event.timestamp,
        };
        renderCCActivity();
        updateEmptyState();
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
