// MCP server entry. Spawned by Claude Code as a stdio child process. The
// server is a thin proxy: every tool call hits the running Schematic
// daemon's HTTP API and returns the result. Keeps the MCP layer small and
// lets the daemon stay the single source of truth.
//
// If the daemon isn't running, tools return "(daemon not running)" text so
// Claude gets a meaningful signal instead of a cryptic transport error —
// Schematic must never break a CC session (see FALLBACK_AUDIT.md).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readOrInitConfig } from "../daemon/persist/config.js";
import type { Workspace } from "../shared/workspace.js";
import type {
  Canvas,
  CanvasEdge,
  CanvasFile,
  CanvasNode,
} from "../shared/canvas.js";

async function daemonUrl(path: string): Promise<string> {
  const cfg = await readOrInitConfig();
  return `http://127.0.0.1:${cfg.port}${path}`;
}

async function fetchOrNull<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(await daemonUrl(path));
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch (e) {
    // Network errors (daemon down, CORS, etc.) — return null so the caller
    // emits a user-facing "daemon not running" response rather than throwing
    // into the MCP transport.
    const direct = (e as NodeJS.ErrnoException).code;
    const nested = ((e as { cause?: NodeJS.ErrnoException }).cause)?.code;
    const code = direct ?? nested;
    const networkErrors = new Set([
      "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
    ]);
    if (code && networkErrors.has(code)) return null;
    throw e;
  }
}

async function postOrNull<T>(path: string, body: unknown): Promise<T | null> {
  return sendOrNull<T>("POST", path, body);
}

// Shared send helper for non-GET requests. Returns null on network failure
// (so callers render "daemon down" instead of crashing MCP transport) and
// on HTTP !2xx (so callers can emit a meaningful message). Body may be
// undefined for DELETE.
async function sendOrNull<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | null> {
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const r = await fetch(await daemonUrl(path), init);
    if (!r.ok) return null;
    if (r.status === 204) return {} as T;
    return (await r.json()) as T;
  } catch (e) {
    const direct = (e as NodeJS.ErrnoException).code;
    const nested = ((e as { cause?: NodeJS.ErrnoException }).cause)?.code;
    const code = direct ?? nested;
    const networkErrors = new Set([
      "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
    ]);
    if (code && networkErrors.has(code)) return null;
    throw e;
  }
}

// Resolves the workspace the canvas-authoring tools operate on.
//
// Prefers the workspace containing the session's cwd — each CC session
// spawns its own MCP subprocess with its own cwd, so this lets multiple
// concurrent sessions (one per repo) author canvases in their OWN
// workspaces without stepping on each other. Sessions A/B/C in repos
// /A, /B, /C each file their canvases under the right repo.
//
// Falls back to the browser's focused workspace only when the session's
// cwd isn't inside any registered repo — the "user is in ~/tmp and told
// Claude to make a diagram" case.
async function sessionWorkspace(): Promise<Workspace | null> {
  const cwd = process.cwd();
  const resolved = await fetchOrNull<{ workspace: Workspace | null }>(
    `/resolve?cwd=${encodeURIComponent(cwd)}`,
  );
  if (resolved?.workspace) return resolved.workspace;

  // Fallback: the workspace the browser is currently showing.
  const focus = await fetchOrNull<{ workspace_id: string | null }>("/focus");
  if (!focus?.workspace_id) return null;
  const list = await fetchOrNull<Workspace[]>("/workspaces");
  return list?.find((w) => w.id === focus.workspace_id) ?? null;
}

function daemonDownResponse(reason: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: reason }] };
}

// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "schematic",
  version: "0.0.1",
});

server.tool(
  "list_workspaces",
  "List every repo Schematic knows about. Use this to resolve a user-supplied name (e.g. 'gatestack pro') to a workspace id before calling switch_view. Returns id, name, root path, and state (active/paused/disabled).",
  {},
  async () => {
    const list = await fetchOrNull<Workspace[]>("/workspaces");
    if (list === null) {
      return daemonDownResponse("Schematic daemon is not reachable. Run `schematic start`.");
    }
    const payload = list.map((w) => ({ id: w.id, name: w.name, root: w.root, state: w.state }));
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  "open_workspace",
  "Activate a repo and make it the current view in the Schematic browser. path must be an absolute filesystem path inside the repo. If the repo isn't registered yet, this registers and activates it; if it is, it just focuses the view. Returns the workspace id and the browser URL.",
  { path: z.string() },
  async ({ path: repoPath }) => {
    const resolved = await fetchOrNull<{
      workspace: Workspace | null;
      shouldAutoActivate: boolean;
      root: string | null;
    }>(`/resolve?cwd=${encodeURIComponent(repoPath)}`);
    if (resolved === null) {
      return daemonDownResponse("Schematic daemon is not reachable. Run `schematic start`.");
    }
    if (!resolved.root) {
      return { content: [{ type: "text", text: `No repo root found at or above ${repoPath}. A repo must contain .git or .schematic.json.` }] };
    }

    let ws = resolved.workspace;
    if (!ws) {
      ws = await postOrNull<Workspace>("/workspaces", { path: resolved.root });
      if (!ws) return daemonDownResponse("Failed to register workspace.");
    } else if (ws.state !== "active") {
      const updated = await postOrNull<Workspace>(`/workspaces/${ws.id}/state`, { to: "active" });
      if (updated) ws = updated;
    }

    const focus = await postOrNull<{ ok: boolean }>("/focus", { workspace_id: ws.id });
    if (!focus) return daemonDownResponse("Failed to focus workspace.");

    const cfg = await readOrInitConfig();
    const payload = {
      id: ws.id,
      name: ws.name,
      root: ws.root,
      state: ws.state,
      url: `http://localhost:${cfg.port}/`,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  "switch_view",
  "Change which already-registered workspace the browser is showing, by id or by name (case-insensitive substring match). Use list_workspaces first if you need to disambiguate. Does not activate or register anything — use open_workspace for that.",
  { id_or_name: z.string() },
  async ({ id_or_name }) => {
    const list = await fetchOrNull<Workspace[]>("/workspaces");
    if (list === null) {
      return daemonDownResponse("Schematic daemon is not reachable. Run `schematic start`.");
    }
    const needle = id_or_name.toLowerCase();
    const match =
      list.find((w) => w.id === id_or_name) ??
      list.find((w) => w.name.toLowerCase() === needle) ??
      list.find((w) => w.name.toLowerCase().includes(needle));
    if (!match) {
      return { content: [{ type: "text", text: `No workspace matches '${id_or_name}'. Known: ${list.map((w) => w.name).join(", ") || "(none)"}.` }] };
    }
    const focus = await postOrNull<{ ok: boolean }>("/focus", { workspace_id: match.id });
    if (!focus) return daemonDownResponse("Failed to focus workspace.");
    return { content: [{ type: "text", text: JSON.stringify({ id: match.id, name: match.name, root: match.root }, null, 2) }] };
  },
);

server.tool(
  "pause_workspace",
  "Stop Schematic from tracking file changes in a workspace without forgetting it. Useful when the user is done with a repo but may return to it. Accepts id or name (same matching rules as switch_view).",
  { id_or_name: z.string() },
  async ({ id_or_name }) => {
    const list = await fetchOrNull<Workspace[]>("/workspaces");
    if (list === null) {
      return daemonDownResponse("Schematic daemon is not reachable. Run `schematic start`.");
    }
    const needle = id_or_name.toLowerCase();
    const match =
      list.find((w) => w.id === id_or_name) ??
      list.find((w) => w.name.toLowerCase() === needle) ??
      list.find((w) => w.name.toLowerCase().includes(needle));
    if (!match) {
      return { content: [{ type: "text", text: `No workspace matches '${id_or_name}'.` }] };
    }
    const updated = await postOrNull<Workspace>(`/workspaces/${match.id}/state`, { to: "paused" });
    if (!updated) return daemonDownResponse("Failed to pause workspace.");
    return { content: [{ type: "text", text: `Paused ${updated.name}.` }] };
  },
);

// focus_node from pre-canvas days used a /selection endpoint that no longer
// exists — the canvas era doesn't have a single "selected node" concept at
// the workspace level (each canvas has its own selection). If selection
// highlighting becomes valuable again, it belongs as a canvas-scoped tool
// that takes canvas_id + node_id.

// ---------------------------------------------------------------------------
// Canvas authoring. These tools let Claude construct diagrams on behalf of
// the user. They resolve the target workspace from Claude's cwd first (so
// each CC session works inside its own repo), and fall back to whatever
// the browser has focused if cwd isn't inside a registered repo.
// ---------------------------------------------------------------------------

const NO_FOCUS_MSG =
  "Could not resolve a Schematic workspace. Claude's cwd isn't inside a registered repo and no workspace is open in the browser. Either cd into a repo (with .git or .schematic.json) or call open_workspace first.";

server.tool(
  "create_canvas",
  `Create a new diagram canvas in the workspace containing Claude's cwd (the repo you're working in). If the cwd isn't inside a registered repo, falls back to whichever workspace is currently open in the Schematic browser. This is the entry point when the user asks you to diagram something.

Workflow: create_canvas → add_node for each file → add_edge for each relationship. The user sees the canvas live in their browser at localhost:7777.

Naming: scope canvases tightly. Prefer "WebGL Pipeline", "Auth Flow", "G1 Engine" over "Full Architecture". Focused diagrams are readable; kitchen-sink diagrams aren't. If the user asks for "the whole repo", consider creating several canvases for different concerns instead.

Coordinate system: canvas-space units, bottom-left origin. Typical canvas is ~2000x1500 units. Default node size is 180x50. Lay out by data flow — inputs on the left, outputs on the right, top-to-bottom for sequences. Group related files spatially AND via the \`process\` argument on add_node so they also render inside a labeled group.

Returns the canvas id for subsequent add_node and add_edge calls.`,
  { name: z.string(), description: z.string().optional() },
  async ({ name, description }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const body: { name: string; description?: string } = { name };
    if (description !== undefined) body.description = description;
    const file = await postOrNull<CanvasFile>(
      `/workspaces/${ws.id}/canvases`,
      body,
    );
    if (!file) return daemonDownResponse("Failed to create canvas.");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { canvas_id: file.canvas.id, workspace: ws.name, name: file.canvas.name },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "list_canvases",
  "List every canvas in the workspace containing Claude's cwd (or the browser's focused workspace if cwd isn't in a registered repo). Useful when the user asks you to extend or modify an existing diagram — find it by name here, then use its id for subsequent add_node/add_edge calls.",
  {},
  async () => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const list = await fetchOrNull<Canvas[]>(`/workspaces/${ws.id}/canvases`);
    if (list === null) return daemonDownResponse("Failed to list canvases.");
    const payload = list.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      updated_at: c.updated_at,
    }));
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  "add_node",
  `Place a file on a canvas as a box. The node represents an instance of that file on this canvas — the same file can appear as multiple nodes on the same canvas or across canvases, and activity pulses fan out to every instance when the file is touched.

Arguments:
- file_path: workspace-relative path, e.g. 'app/src/daemon/http.ts'. Must match the real path on disk; it's how CC edits get mapped back to this box.
- x, y: bottom-left corner in canvas-space units. Typical ranges 0-2000 horizontally, 0-1500 vertically. Omit both to auto-grid (convenient when laying out many nodes at once).
- width, height: in canvas-space units. Default 180x50. Bump width up for files with long names.
- process: optional grouping label like 'WebGL Chart' or 'G1 Engine'. Nodes with the same process render inside a shared rounded outline with the process name pilled at the top. One process per node — a file that belongs to two processes should be represented as two separate nodes.

Layout guidance: think of the canvas like a Mermaid flow diagram. Arrange nodes so data flows left-to-right or top-to-bottom; keep related files near each other spatially AND via a shared process label. Don't stack files in a single vertical column — it makes edges unreadable.

Returns the node id for subsequent add_edge and move_node calls.`,
  {
    canvas_id: z.string(),
    file_path: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    process: z.string().optional(),
  },
  async ({ canvas_id, file_path, x, y, width, height, process: processLabel }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const body: Record<string, unknown> = { file_path };
    if (x !== undefined) body.x = x;
    if (y !== undefined) body.y = y;
    if (width !== undefined) body.width = width;
    if (height !== undefined) body.height = height;
    if (processLabel !== undefined) body.process = processLabel;
    const node = await postOrNull<CanvasNode>(
      `/workspaces/${ws.id}/canvases/${canvas_id}/nodes`,
      body,
    );
    if (!node) return daemonDownResponse("Failed to add node. Check the canvas_id exists.");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { node_id: node.id, file_path: node.file_path, x: node.x, y: node.y },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "add_edge",
  `Draw a wire between two nodes on a canvas. Represents a relationship — not necessarily a code-level import. An edge can be a conceptual dependency ("auth gates app"), a data flow ("feeds 1s bars"), or a call relationship ("invokes").

Arguments:
- src, dst: node ids returned by add_node. Direction matters — the arrow points src → dst.
- label: free text, shown on the wire as a pill. Short is better — "loads buffers", "authenticates via", "broadcasts to". Tells the reader WHY these two components connect.
- kind: color hint, one of calls | imports | reads | writes | control | custom. Default is custom. Use the fixed kinds when the relationship cleanly fits; use custom + a descriptive label for anything else. Multiple kinds on the same canvas are fine.

Guidance: don't mirror every import statement — that clutters. Draw edges that communicate intent. One "reads from" arrow that summarizes ten grep calls is worth more than ten separate arrows.`,
  {
    canvas_id: z.string(),
    src: z.string(),
    dst: z.string(),
    label: z.string().optional(),
    kind: z
      .enum(["calls", "imports", "reads", "writes", "control", "custom"])
      .optional(),
  },
  async ({ canvas_id, src, dst, label, kind }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const body: Record<string, unknown> = { src, dst };
    if (label !== undefined) body.label = label;
    if (kind !== undefined) body.kind = kind;
    const edge = await postOrNull<CanvasEdge>(
      `/workspaces/${ws.id}/canvases/${canvas_id}/edges`,
      body,
    );
    if (!edge) return daemonDownResponse("Failed to add edge. Check both node ids exist on this canvas.");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ edge_id: edge.id }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "move_node",
  "Reposition a node on its canvas. x and y are bottom-left in canvas-space units (same coordinate system as add_node). Use this to tidy up layout after adding many nodes at once — Schematic auto-grids newly-placed nodes in a simple left-to-right flow, and you (or the user) may want to arrange them by data flow instead.",
  { canvas_id: z.string(), node_id: z.string(), x: z.number(), y: z.number() },
  async ({ canvas_id, node_id, x, y }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const node = await sendOrNull<CanvasNode>(
      "PATCH",
      `/workspaces/${ws.id}/canvases/${canvas_id}/nodes/${node_id}`,
      { x, y },
    );
    if (!node) return daemonDownResponse("Failed to move node. Check the canvas_id and node_id.");
    return { content: [{ type: "text", text: `Moved to (${node.x}, ${node.y}).` }] };
  },
);

server.tool(
  "delete_node",
  "Remove a node from a canvas. Any edges touching the node are deleted too — a dangling edge would be an illegal state.",
  { canvas_id: z.string(), node_id: z.string() },
  async ({ canvas_id, node_id }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const r = await sendOrNull<{ ok: boolean }>(
      "DELETE",
      `/workspaces/${ws.id}/canvases/${canvas_id}/nodes/${node_id}`,
    );
    if (!r) return daemonDownResponse("Failed to delete node.");
    return { content: [{ type: "text", text: `Deleted node ${node_id}.` }] };
  },
);

// ---------------------------------------------------------------------------
// Structural query tools — read-only introspection so Claude can make
// architecturally-aware decisions. Each returns structured JSON (not prose)
// so Claude can reason over the shape without parsing narrative.
// ---------------------------------------------------------------------------

server.tool(
  "audit_canvas",
  `Check a canvas for drift against the filesystem. Walks every node, stats its file_path, reports missing files (stale), existing files, and file_paths that appear on more than one node.

Get the canvas_id from list_canvases first.

When to use: (1) user says "that diagram looks wrong" → audit surfaces stale nodes; (2) before a major refactor → audit so you know what's real; (3) after a reorganization → audit to find what needs updating.

Returns JSON: { canvas_id, canvas_name, missing: [{ node_id, file_path }], existing: [...], duplicates: [{ file_path, node_ids }], summary: { node_count, missing_count, duplicate_file_count } }.

Duplicates are informational, not errors — a file can legitimately appear multiple times on a canvas (playing two roles). Surface them so the user can confirm the intent.`,
  { canvas_id: z.string() },
  async ({ canvas_id }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const report = await fetchOrNull<unknown>(
      `/workspaces/${ws.id}/canvases/${canvas_id}/audit`,
    );
    if (report === null) return daemonDownResponse("Failed to audit canvas. Check the canvas_id exists.");
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "find_hubs",
  `Identify keystone files on a canvas — nodes with many incoming + outgoing edges. High-degree nodes are risky to refactor because changes cascade widely.

Get the canvas_id from list_canvases first.

Arguments:
- canvas_id: canvas to analyze.
- min_degree (optional, default 3): only return nodes with in+out degree >= this.

Returns JSON: { canvas_id, canvas_name, threshold, hubs: [{ node_id, file_path, process?, in_degree, out_degree, total_degree }, ...] } sorted by total_degree descending.

When to use: before proposing a refactor. If the target file is a hub, consider a narrower scope, additional test coverage, or breaking the change into steps.`,
  { canvas_id: z.string(), min_degree: z.number().optional() },
  async ({ canvas_id, min_degree }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const qs = min_degree !== undefined ? `?min_degree=${min_degree}` : "";
    const report = await fetchOrNull<unknown>(
      `/workspaces/${ws.id}/canvases/${canvas_id}/hubs${qs}`,
    );
    if (report === null) return daemonDownResponse("Failed to fetch hubs. Check the canvas_id exists.");
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "find_orphans",
  `List nodes with zero edges on a canvas. Orphans are usually either forgotten dependencies (meant to be wired up) or placeholders that never got connected.

Get the canvas_id from list_canvases first.

Returns JSON: { canvas_id, canvas_name, orphans: [{ node_id, file_path, process? }, ...] }.

When to use: canvas cleanup. For each orphan, ask the user whether it should be wired up or removed.`,
  { canvas_id: z.string() },
  async ({ canvas_id }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const report = await fetchOrNull<unknown>(
      `/workspaces/${ws.id}/canvases/${canvas_id}/orphans`,
    );
    if (report === null) return daemonDownResponse("Failed to fetch orphans.");
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "find_cycles",
  `Detect directed cycles in the canvas's edge graph. Circular dependencies are usually design smells — one of the files should own the relationship and break the cycle.

Get the canvas_id from list_canvases first.

Returns JSON: { canvas_id, canvas_name, cycles: [[{ node_id, file_path }, ...], ...] }. Each inner array is one cycle in traversal order. Empty cycles array = no circular dependencies on this canvas.`,
  { canvas_id: z.string() },
  async ({ canvas_id }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const report = await fetchOrNull<unknown>(
      `/workspaces/${ws.id}/canvases/${canvas_id}/cycles`,
    );
    if (report === null) return daemonDownResponse("Failed to fetch cycles.");
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "trace_impact",
  `Ask what would be affected before modifying a file. Returns every canvas node referencing the file, with each instance's incoming and outgoing edges resolved to their other endpoint's file_path — so you can reason about blast radius before proposing a refactor.

Arguments:
- file_path: workspace-relative path, e.g. 'app/src/daemon/http.ts'.

Returns JSON: { file_path, instances: [{ canvas_id, canvas_name, node_id, process?, incoming: [{ other_file_path, label?, kind? }, ...], outgoing: [...] }], summary: { canvas_count, instance_count, incoming_edge_count, outgoing_edge_count, unique_incoming_files, unique_outgoing_files } }.

When to use: at the start of any nontrivial edit — especially on files you're unfamiliar with. Empty instances array = this file isn't mapped on any canvas yet; consider suggesting the user diagram the area before making changes.`,
  { file_path: z.string() },
  async ({ file_path }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const report = await fetchOrNull<unknown>(
      `/workspaces/${ws.id}/impact?file_path=${encodeURIComponent(file_path)}`,
    );
    if (report === null) return daemonDownResponse("Failed to fetch impact report.");
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "delete_edge",
  "Remove an edge from a canvas. Use this when a relationship you authored earlier was wrong or is no longer useful.",
  { canvas_id: z.string(), edge_id: z.string() },
  async ({ canvas_id, edge_id }) => {
    const ws = await sessionWorkspace();
    if (!ws) return daemonDownResponse(NO_FOCUS_MSG);
    const r = await sendOrNull<{ ok: boolean }>(
      "DELETE",
      `/workspaces/${ws.id}/canvases/${canvas_id}/edges/${edge_id}`,
    );
    if (!r) return daemonDownResponse("Failed to delete edge.");
    return { content: [{ type: "text", text: `Deleted edge ${edge_id}.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
