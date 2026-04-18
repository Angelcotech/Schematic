// HTTP endpoints. Minimal surface for Stage 3:
//   GET  /status        — daemon health + counters
//   GET  /workspaces    — current registry
//   POST /hook          — receive CC hook payload, route to workspace, broadcast
//
// Workspace action endpoints (activate/pause/resume/disable/forget) land in
// Stage 4 alongside the CLI that calls them.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { HookPayload } from "../shared/hook-payload.js";
import type { Workspace } from "../shared/workspace.js";
import type { WorkspaceRegistry } from "./workspaces/registry.js";
import type { WSBroadcaster } from "./ws.js";
import { newWorkspace, route } from "./workspaces/router.js";
import type { ActivationManager } from "./workspaces/activate.js";
import type { CanvasStoreRegistry } from "./canvas/store.js";
import type { CanvasEdgeKind } from "../shared/canvas.js";
import type { FileActivityRegistry } from "./file-activity.js";
import { tryServeStatic } from "./static-web.js";
import { readOrInitConfig, writeConfig } from "./persist/config.js";

export interface DaemonContext {
  registry: WorkspaceRegistry;
  canvasStores: CanvasStoreRegistry;
  fileActivity: FileActivityRegistry;
  activations: ActivationManager;
  ws: WSBroadcaster;
  startedAt: number;
  state: { eventCount: number; focusedWorkspaceId: string | null };
}

export function createRequestHandler(
  ctx: DaemonContext,
  requestShutdown: () => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    // Local-only CORS. The daemon binds 127.0.0.1, so Access-Control-Allow-Origin: *
    // only ever allows same-machine browsers. Required so the Vite dev server
    // (on its own port) can fetch from the daemon.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    try {
      const { url, method } = req;
      if (!url || !method) {
        return err(res, 400, "malformed request: missing url or method");
      }

      if (method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      const parsed = new URL(url, "http://localhost");
      const path = parsed.pathname;

      if (method === "GET" && path === "/status") {
        return json(res, 200, {
          ok: true,
          uptime_ms: Date.now() - ctx.startedAt,
          workspaces: ctx.registry.all().length,
          events_processed: ctx.state.eventCount,
          ws_clients: ctx.ws.clientCount(),
        });
      }

      if (method === "POST" && path === "/shutdown") {
        json(res, 200, { ok: true });
        setImmediate(requestShutdown);
        return;
      }

      if (method === "GET" && path === "/workspaces") {
        return json(res, 200, ctx.registry.all());
      }

      // GET /focus — what workspace should the browser currently display.
      if (method === "GET" && path === "/focus") {
        return json(res, 200, { workspace_id: ctx.state.focusedWorkspaceId });
      }

      // POST /focus { workspace_id } — MCP/CLI tells the browser to switch.
      // Broadcasts workspace.focused; frontend reloads the graph for that id.
      // Persists to config.json so a daemon restart keeps the same view.
      if (method === "POST" && path === "/focus") {
        const body = JSON.parse(await readBody(req)) as { workspace_id: string };
        if (!body.workspace_id) return err(res, 400, "missing field: workspace_id");
        const ws = ctx.registry.get(body.workspace_id);
        if (!ws) return err(res, 404, "unknown workspace");
        ctx.state.focusedWorkspaceId = ws.id;
        const cfg = await readOrInitConfig();
        if (cfg.focused_workspace_id !== ws.id) {
          cfg.focused_workspace_id = ws.id;
          await writeConfig(cfg);
        }
        ctx.ws.broadcast(
          { type: "workspace.focused", workspace_id: ws.id, timestamp: Date.now() },
          ws.id,
        );
        return json(res, 200, { ok: true, workspace: ws });
      }

      if (method === "POST" && path === "/workspaces") {
        const body = JSON.parse(await readBody(req)) as { path: string };
        const { path: rootPath } = body;
        if (!rootPath) return err(res, 400, "missing field: path");
        const existing = ctx.registry.findByRoot(rootPath);
        if (existing) return json(res, 200, existing);
        const ws = newWorkspace(rootPath);
        await ctx.registry.create(ws);
        ctx.ws.broadcast({ type: "workspace.activated", workspace: ws, timestamp: Date.now() }, ws.id);
        // Kick off extraction + watcher in the background. Progress + graph_ready
        // events will broadcast as they occur.
        void ctx.activations.activate(ws).catch((e) =>
          console.error(`[schematic] activation failed for ${ws.name}:`, e),
        );
        return json(res, 201, ws);
      }

      // /workspaces/:id/state — POST { to: WorkspaceState }
      const stateMatch = /^\/workspaces\/([^/]+)\/state$/.exec(path);
      if (method === "POST" && stateMatch) {
        const id = stateMatch[1];
        const body = JSON.parse(await readBody(req)) as { to: "active" | "paused" | "disabled" };
        const ws = await ctx.registry.transition(id, body.to);
        const evType =
          body.to === "active"
            ? "workspace.resumed"
            : body.to === "paused"
              ? "workspace.paused"
              : "workspace.disabled";
        ctx.ws.broadcast({ type: evType, workspace_id: ws.id, timestamp: Date.now() }, ws.id);
        if (body.to === "active") {
          void ctx.activations.activate(ws);
        } else {
          ctx.activations.deactivate(ws.id);
        }
        return json(res, 200, ws);
      }

      // /workspaces/:id — DELETE (forget)
      const idMatch = /^\/workspaces\/([^/]+)$/.exec(path);
      if (method === "DELETE" && idMatch) {
        const id = idMatch[1];
        await ctx.registry.forget(id);
        ctx.activations.deactivate(id);
        ctx.fileActivity.drop(id);
        ctx.ws.broadcast({ type: "workspace.forgotten", workspace_id: id, timestamp: Date.now() }, id);
        return json(res, 200, { ok: true });
      }

      // (Stage 17c deleted /graph, /nodes, /selection, /positions, /relayout —
      // all of those served the directory-render pathway. Canvas CRUD above
      // replaces them.)

      // --- Canvases -------------------------------------------------------
      // Canvas CRUD is always scoped to a workspace to keep the URL path
      // self-describing and avoid a reverse canvas→workspace index.

      // GET /workspaces/:wid/canvases  — canvas metadata only (no nodes/edges).
      const canvasListMatch = /^\/workspaces\/([^/]+)\/canvases$/.exec(path);
      if (method === "GET" && canvasListMatch) {
        const wid = canvasListMatch[1];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, store.listCanvases());
      }

      // GET /workspaces/:wid/impact?file_path=... — blast-radius query
      // for Claude: aggregate every canvas node referencing this file,
      // with their edges resolved back to the other endpoint's file_path.
      const impactMatch = /^\/workspaces\/([^/]+)\/impact$/.exec(path);
      if (method === "GET" && impactMatch) {
        const wid = impactMatch[1];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const filePath = parsed.searchParams.get("file_path");
        if (!filePath) return err(res, 400, "missing query param: file_path");
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, store.impactForFile(filePath));
      }

      // GET /workspaces/:wid/canvases/:cid/audit — canvas-vs-disk drift.
      const auditMatch = /^\/workspaces\/([^/]+)\/canvases\/([^/]+)\/audit$/.exec(path);
      if (method === "GET" && auditMatch) {
        const wid = auditMatch[1];
        const cid = auditMatch[2];
        const workspace = ctx.registry.get(wid);
        if (!workspace) return err(res, 404, "unknown workspace");
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, await store.auditCanvas(cid, workspace.root));
      }

      // GET /workspaces/:wid/canvases/:cid/hubs?min_degree=N — high-degree nodes.
      const hubsMatch = /^\/workspaces\/([^/]+)\/canvases\/([^/]+)\/hubs$/.exec(path);
      if (method === "GET" && hubsMatch) {
        const wid = hubsMatch[1];
        const cid = hubsMatch[2];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const minDegreeParam = parsed.searchParams.get("min_degree");
        const minDegree = minDegreeParam ? Math.max(0, parseInt(minDegreeParam, 10) || 0) : 3;
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, store.findHubs(cid, minDegree));
      }

      // GET /workspaces/:wid/canvases/:cid/orphans — zero-edge nodes.
      const orphansMatch = /^\/workspaces\/([^/]+)\/canvases\/([^/]+)\/orphans$/.exec(path);
      if (method === "GET" && orphansMatch) {
        const wid = orphansMatch[1];
        const cid = orphansMatch[2];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, store.findOrphans(cid));
      }

      // GET /workspaces/:wid/canvases/:cid/cycles — directed cycles.
      const cyclesMatch = /^\/workspaces\/([^/]+)\/canvases\/([^/]+)\/cycles$/.exec(path);
      if (method === "GET" && cyclesMatch) {
        const wid = cyclesMatch[1];
        const cid = cyclesMatch[2];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, store.findCycles(cid));
      }

      // POST /workspaces/:wid/canvases  { name, description? }
      if (method === "POST" && canvasListMatch) {
        const wid = canvasListMatch[1];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const body = JSON.parse(await readBody(req)) as {
          name?: string;
          description?: string;
        };
        if (typeof body.name !== "string" || body.name.length === 0) {
          return err(res, 400, "missing field: name");
        }
        const store = await ctx.canvasStores.getOrLoad(wid);
        const file = await store.createCanvas(body.name, body.description);
        ctx.ws.broadcast(
          { type: "canvas.created", workspace_id: wid, canvas: file.canvas, timestamp: Date.now() },
          wid,
        );
        return json(res, 201, file);
      }

      // GET /workspaces/:wid/canvases/:cid  — full canvas with nodes+edges.
      const canvasIdMatch = /^\/workspaces\/([^/]+)\/canvases\/([^/]+)$/.exec(path);
      if (method === "GET" && canvasIdMatch) {
        const wid = canvasIdMatch[1];
        const cid = canvasIdMatch[2];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, store.getCanvas(cid));
      }

      // PATCH /workspaces/:wid/canvases/:cid  { name?, description?, hidden? }
      if (method === "PATCH" && canvasIdMatch) {
        const wid = canvasIdMatch[1];
        const cid = canvasIdMatch[2];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const body = JSON.parse(await readBody(req)) as {
          name?: string;
          description?: string;
          hidden?: boolean;
        };
        const store = await ctx.canvasStores.getOrLoad(wid);
        const canvas = await store.updateCanvas(cid, body);
        ctx.ws.broadcast(
          { type: "canvas.updated", workspace_id: wid, canvas, timestamp: Date.now() },
          wid,
        );
        return json(res, 200, canvas);
      }

      // DELETE /workspaces/:wid/canvases/:cid
      if (method === "DELETE" && canvasIdMatch) {
        const wid = canvasIdMatch[1];
        const cid = canvasIdMatch[2];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const store = await ctx.canvasStores.getOrLoad(wid);
        await store.deleteCanvas(cid);
        ctx.ws.broadcast(
          { type: "canvas.deleted", workspace_id: wid, canvas_id: cid, timestamp: Date.now() },
          wid,
        );
        return json(res, 200, { ok: true });
      }

      // POST /workspaces/:wid/canvases/:cid/nodes  — add node.
      // Position (x, y) is optional; omitting it triggers auto-grid placement.
      const nodeListMatch =
        /^\/workspaces\/([^/]+)\/canvases\/([^/]+)\/nodes$/.exec(path);
      if (method === "POST" && nodeListMatch) {
        const wid = nodeListMatch[1];
        const cid = nodeListMatch[2];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const body = JSON.parse(await readBody(req)) as {
          file_path?: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          process?: string;
        };
        if (typeof body.file_path !== "string" || body.file_path.length === 0) {
          return err(res, 400, "missing field: file_path");
        }
        const store = await ctx.canvasStores.getOrLoad(wid);
        const node = await store.addNode(cid, {
          file_path: body.file_path,
          ...(body.x !== undefined ? { x: body.x } : {}),
          ...(body.y !== undefined ? { y: body.y } : {}),
          ...(body.width !== undefined ? { width: body.width } : {}),
          ...(body.height !== undefined ? { height: body.height } : {}),
          ...(body.process !== undefined ? { process: body.process } : {}),
        });
        return json(res, 201, node);
      }

      // PATCH /workspaces/:wid/canvases/:cid/nodes/:nid
      // DELETE /workspaces/:wid/canvases/:cid/nodes/:nid
      const nodeIdMatch =
        /^\/workspaces\/([^/]+)\/canvases\/([^/]+)\/nodes\/([^/]+)$/.exec(path);
      if (method === "PATCH" && nodeIdMatch) {
        const wid = nodeIdMatch[1];
        const cid = nodeIdMatch[2];
        const nid = nodeIdMatch[3];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of ["x", "y", "width", "height", "process", "file_path"]) {
          if (k in body) patch[k] = body[k];
        }
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, await store.updateNode(cid, nid, patch));
      }
      if (method === "DELETE" && nodeIdMatch) {
        const wid = nodeIdMatch[1];
        const cid = nodeIdMatch[2];
        const nid = nodeIdMatch[3];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const store = await ctx.canvasStores.getOrLoad(wid);
        await store.deleteNode(cid, nid);
        return json(res, 200, { ok: true });
      }

      // POST /workspaces/:wid/canvases/:cid/edges  { src, dst, label?, kind? }
      const edgeListMatch =
        /^\/workspaces\/([^/]+)\/canvases\/([^/]+)\/edges$/.exec(path);
      if (method === "POST" && edgeListMatch) {
        const wid = edgeListMatch[1];
        const cid = edgeListMatch[2];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const body = JSON.parse(await readBody(req)) as {
          src?: string;
          dst?: string;
          label?: string;
          kind?: string;
        };
        if (typeof body.src !== "string") return err(res, 400, "missing field: src");
        if (typeof body.dst !== "string") return err(res, 400, "missing field: dst");
        const kind = parseEdgeKind(body.kind);
        if (kind === null) return err(res, 400, `invalid edge kind: ${String(body.kind)}`);
        const store = await ctx.canvasStores.getOrLoad(wid);
        const edge = await store.addEdge(cid, {
          src: body.src,
          dst: body.dst,
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(kind !== undefined ? { kind } : {}),
        });
        return json(res, 201, edge);
      }

      // PATCH /workspaces/:wid/canvases/:cid/edges/:eid
      // DELETE /workspaces/:wid/canvases/:cid/edges/:eid
      const edgeIdMatch =
        /^\/workspaces\/([^/]+)\/canvases\/([^/]+)\/edges\/([^/]+)$/.exec(path);
      if (method === "PATCH" && edgeIdMatch) {
        const wid = edgeIdMatch[1];
        const cid = edgeIdMatch[2];
        const eid = edgeIdMatch[3];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const body = JSON.parse(await readBody(req)) as {
          label?: string;
          kind?: string;
        };
        const patch: { label?: string; kind?: CanvasEdgeKind } = {};
        if (body.label !== undefined) patch.label = body.label;
        if (body.kind !== undefined) {
          const parsedKind = parseEdgeKind(body.kind);
          if (parsedKind === null) return err(res, 400, `invalid edge kind: ${String(body.kind)}`);
          if (parsedKind !== undefined) patch.kind = parsedKind;
        }
        const store = await ctx.canvasStores.getOrLoad(wid);
        return json(res, 200, await store.updateEdge(cid, eid, patch));
      }
      if (method === "DELETE" && edgeIdMatch) {
        const wid = edgeIdMatch[1];
        const cid = edgeIdMatch[2];
        const eid = edgeIdMatch[3];
        if (!ctx.registry.get(wid)) return err(res, 404, "unknown workspace");
        const store = await ctx.canvasStores.getOrLoad(wid);
        await store.deleteEdge(cid, eid);
        return json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/resolve") {
        const cwd = parsed.searchParams.get("cwd");
        if (!cwd) return err(res, 400, "missing query param: cwd");
        const routed = await route(cwd, ctx.registry);
        return json(res, 200, {
          workspace: routed.workspace,
          shouldAutoActivate: routed.shouldAutoActivate,
          root: routed.root,
        });
      }

      if (method === "POST" && path === "/hook") {
        const raw = await readBody(req);
        const ccPayload = JSON.parse(raw) as unknown;
        const normalized = normalizeHook(ccPayload);
        const result = await handleHook(ctx, normalized);
        if (normalized.event === "UserPromptSubmit") {
          // Claude Code requires hookEventName inside hookSpecificOutput —
          // without it the payload fails schema validation and the hook is
          // reported as an error on every user prompt.
          return json(res, 200, {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: result.additionalContext ?? "",
            },
          });
        }
        return json(res, 200, {});
      }

      // Static frontend fallback — if no API route matched, try serving
      // from the bundled web/ directory (installed alongside the daemon).
      if (await tryServeStatic(req, res)) return;

      return err(res, 404, `unknown route: ${method} ${path}`);
    } catch (e) {
      // Canvas store throws Error with code="ENOENT" for missing canvas/node/
      // edge lookups — surface those as 404 instead of collapsing to 500.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return err(res, 404, (e as Error).message);
      }
      const message = (e as Error).message;
      console.error("[schematic] request error:", e);
      return err(res, 500, message);
    }
  };
}

// Strict edge-kind validator. The enum is fixed; "custom" is the escape
// hatch for relationships the fixed vocabulary doesn't cover — label carries
// the semantics in that case. Returns null for invalid, undefined for
// absent, so endpoints can distinguish "not provided" from "rejected".
const VALID_EDGE_KINDS = new Set<string>([
  "calls", "imports", "reads", "writes", "control", "custom",
]);
function parseEdgeKind(v: unknown): CanvasEdgeKind | null | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && VALID_EDGE_KINDS.has(v)) {
    return v as CanvasEdgeKind;
  }
  return null;
}

// Translates CC's stdin JSON into our strict HookPayload. Each hook event has
// its own CC fields; we extract the ones relevant to Schematic's bookkeeping.
function normalizeHook(raw: unknown): HookPayload {
  const cc = raw as Record<string, unknown>;
  const eventName = cc["hook_event_name"] ?? cc["event"];
  if (eventName !== "PreToolUse" && eventName !== "PostToolUse" && eventName !== "UserPromptSubmit") {
    throw new Error(`[schematic] unknown hook event: ${String(eventName)}`);
  }
  const cwd = cc["cwd"];
  if (typeof cwd !== "string") throw new Error("[schematic] hook missing cwd");
  const sessionId = cc["session_id"];
  if (typeof sessionId !== "string") throw new Error("[schematic] hook missing session_id");

  const toolName = typeof cc["tool_name"] === "string" ? (cc["tool_name"] as string) : null;
  const toolInput = (cc["tool_input"] as Record<string, unknown> | undefined) ?? undefined;
  const toolResponse = cc["tool_response"] as Record<string, unknown> | undefined;

  // Target file path extraction — Edit / Write / Read all use `file_path` in tool_input.
  let target: string | null = null;
  if (toolInput) {
    const fp = toolInput["file_path"];
    if (typeof fp === "string") target = fp;
  }

  let success: boolean | null = null;
  if (toolResponse && typeof toolResponse["success"] === "boolean") {
    success = toolResponse["success"] as boolean;
  }

  const prompt = typeof cc["prompt"] === "string" ? (cc["prompt"] as string) : null;

  return {
    event: eventName,
    tool: toolName,
    target,
    cwd,
    session_id: sessionId,
    timestamp: Date.now(),
    success,
    prompt,
  };
}

interface HookResult {
  additionalContext?: string;
}

async function handleHook(ctx: DaemonContext, payload: HookPayload): Promise<HookResult> {
  ctx.state.eventCount++;
  const routed = await route(payload.cwd, ctx.registry);

  let workspace: Workspace | null = routed.workspace;

  if (!workspace && routed.shouldAutoActivate && routed.root) {
    workspace = newWorkspace(routed.root);
    await ctx.registry.create(workspace);
    ctx.ws.broadcast(
      { type: "workspace.activated", workspace, timestamp: Date.now() },
      workspace.id,
    );
    // Fire-and-forget activation — starts health runners, no extraction.
    void ctx.activations.activate(workspace).catch((e) =>
      console.error(`[schematic] auto-activation failed:`, e),
    );
  }

  if (!workspace) return {};
  if (workspace.state !== "active") return {};

  await ctx.registry.touch(workspace.id);
  // Broadcast hook.received with no workspace scope so the browser can
  // surface CC-session activity regardless of which workspace it's
  // currently viewing. Volume is low (one per CC tool call).
  ctx.ws.broadcast(
    { type: "hook.received", workspace_id: workspace.id, payload, timestamp: Date.now() },
  );

  const activityStore = ctx.fileActivity.getOrCreate(workspace.id);
  const activityChange = activityStore.applyHook(workspace, payload);
  if (activityChange) {
    ctx.ws.broadcast(
      {
        type: "file.activity",
        workspace_id: workspace.id,
        file_path: activityChange.file_path,
        activity: activityChange,
        timestamp: Date.now(),
      },
      workspace.id,
    );
  }

  // UserPromptSubmit returns additionalContext. In canvas mode we don't
  // auto-inject a graph summary — CC authors canvases on demand. Keeping
  // the handler arm in case we later want to surface "here are the
  // canvases in this workspace" as context.
  if (payload.event === "UserPromptSubmit") {
    return { additionalContext: "" };
  }

  return {};
}

// --- tiny response helpers ---

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(s).toString());
  res.end(s);
}

function err(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
