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
import type { NodeStoreRegistry } from "./node-store.js";

export interface DaemonContext {
  registry: WorkspaceRegistry;
  nodeStores: NodeStoreRegistry;
  ws: WSBroadcaster;
  startedAt: number;
  state: { eventCount: number };
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

      if (method === "POST" && path === "/workspaces") {
        const body = JSON.parse(await readBody(req)) as { path: string };
        const { path: rootPath } = body;
        if (!rootPath) return err(res, 400, "missing field: path");
        const existing = ctx.registry.findByRoot(rootPath);
        if (existing) return json(res, 200, existing);
        const ws = newWorkspace(rootPath);
        await ctx.registry.create(ws);
        ctx.ws.broadcast({ type: "workspace.activated", workspace: ws, timestamp: Date.now() }, ws.id);
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
        return json(res, 200, ws);
      }

      // /workspaces/:id — DELETE (forget)
      const idMatch = /^\/workspaces\/([^/]+)$/.exec(path);
      if (method === "DELETE" && idMatch) {
        const id = idMatch[1];
        await ctx.registry.forget(id);
        ctx.nodeStores.drop(id);
        ctx.ws.broadcast({ type: "workspace.forgotten", workspace_id: id, timestamp: Date.now() }, id);
        return json(res, 200, { ok: true });
      }

      // /workspaces/:id/nodes — GET current NodeState snapshot (lets a
      // reconnecting browser bootstrap without waiting for new hook events).
      const nodesMatch = /^\/workspaces\/([^/]+)\/nodes$/.exec(path);
      if (method === "GET" && nodesMatch) {
        const id = nodesMatch[1];
        const store = ctx.nodeStores.get(id);
        return json(res, 200, store?.all() ?? []);
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
          return json(res, 200, {
            hookSpecificOutput: { additionalContext: result.additionalContext ?? "" },
          });
        }
        return json(res, 200, {});
      }

      return err(res, 404, `unknown route: ${method} ${path}`);
    } catch (e) {
      const message = (e as Error).message;
      console.error("[schematic] request error:", e);
      return err(res, 500, message);
    }
  };
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
  }

  // If no workspace exists and no marker is present, drop the hook. This is
  // NOT a fallback — it is the designed state machine: hooks from unmarked
  // cwds are silently ignored until explicit activation via CLI or UI.
  if (!workspace) return {};

  if (workspace.state !== "active") return {};

  await ctx.registry.touch(workspace.id);
  ctx.ws.broadcast(
    { type: "hook.received", workspace_id: workspace.id, payload, timestamp: Date.now() },
    workspace.id,
  );

  // Apply the hook to the workspace's bootstrap node store. Stage 6 replaces
  // this with full graph extraction; until then this is how file-level
  // activity becomes visible in the frontend.
  const store = ctx.nodeStores.getOrCreate(workspace.id);
  const change = store.applyHook(workspace, payload);
  if (change) {
    ctx.ws.broadcast(
      {
        type: "node.state_change",
        workspace_id: workspace.id,
        node_id: change.id,
        node: change.node,
        timestamp: Date.now(),
      },
      workspace.id,
    );
  }

  // arch-context for UserPromptSubmit — populated in Stage 10. For now the
  // hook flow is wired end-to-end but the injected context is empty.
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
