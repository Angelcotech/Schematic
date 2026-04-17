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
import { deleteCache } from "./cache/graph-cache.js";
import {
  deletePositions,
  readPositions,
  writePositions,
} from "./cache/positions.js";
import type { NodeStoreRegistry } from "./node-store.js";
import type { ActivationManager } from "./workspaces/activate.js";
import { buildArchContext } from "./context/arch-context.js";

export interface DaemonContext {
  registry: WorkspaceRegistry;
  nodeStores: NodeStoreRegistry;
  activations: ActivationManager;
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
        ctx.nodeStores.drop(id);
        ctx.ws.broadcast({ type: "workspace.forgotten", workspace_id: id, timestamp: Date.now() }, id);
        return json(res, 200, { ok: true });
      }

      // /workspaces/:id/nodes — legacy endpoint kept for Stage 5 back-compat.
      const nodesMatch = /^\/workspaces\/([^/]+)\/nodes$/.exec(path);
      if (method === "GET" && nodesMatch) {
        const id = nodesMatch[1];
        const store = ctx.nodeStores.get(id);
        return json(res, 200, store?.all() ?? []);
      }

      // /workspaces/:id/graph — full { nodes, edges } snapshot for the browser.
      const graphMatch = /^\/workspaces\/([^/]+)\/graph$/.exec(path);
      if (method === "GET" && graphMatch) {
        const id = graphMatch[1];
        const store = ctx.nodeStores.get(id);
        return json(res, 200, {
          nodes: store?.all() ?? [],
          edges: store?.edges() ?? [],
        });
      }

      // /workspaces/:id/selection — POST { node_id: string | null }
      // Frontend mirrors its current selection here so arch-context can
      // read it on the next UserPromptSubmit.
      const selectionMatch = /^\/workspaces\/([^/]+)\/selection$/.exec(path);
      if (method === "POST" && selectionMatch) {
        const id = selectionMatch[1];
        const store = ctx.nodeStores.get(id);
        if (!store) return err(res, 404, "unknown workspace");
        const body = JSON.parse(await readBody(req)) as { node_id: string | null };
        store.setSelection(body.node_id);
        return json(res, 200, { ok: true });
      }

      // /workspaces/:id/positions — POST { positions: [...] }
      // Applies manual drag results, marks nodes as manually_positioned,
      // and writes to positions.json so they survive daemon restart and
      // re-extractions (per Invariant #6).
      const positionsMatch = /^\/workspaces\/([^/]+)\/positions$/.exec(path);
      if (method === "POST" && positionsMatch) {
        const id = positionsMatch[1];
        const store = ctx.nodeStores.get(id);
        if (!store) return err(res, 404, "unknown workspace");
        const body = JSON.parse(await readBody(req)) as {
          positions: Array<{ node_id: string; x: number; y: number; width?: number; height?: number }>;
        };
        store.applyPositions(body.positions);

        // Merge with existing persisted overrides so a drag on one module
        // doesn't wipe another's previously-saved position.
        const existing = await readPositions(id);
        for (const p of body.positions) {
          const entry: { x: number; y: number; width?: number; height?: number } = {
            x: p.x,
            y: p.y,
          };
          if (p.width !== undefined) entry.width = p.width;
          if (p.height !== undefined) entry.height = p.height;
          existing[p.node_id] = entry;
        }
        await writePositions(id, existing);

        return json(res, 200, { ok: true, updated: body.positions.length });
      }

      // /workspaces/:id/relayout — POST, wipes manual positions and triggers
      // a fresh extraction.
      const relayoutMatch = /^\/workspaces\/([^/]+)\/relayout$/.exec(path);
      if (method === "POST" && relayoutMatch) {
        const id = relayoutMatch[1];
        const workspace = ctx.registry.get(id);
        if (!workspace) return err(res, 404, "unknown workspace");
        const store = ctx.nodeStores.get(id);
        store?.clearManualPositions();
        await deleteCache(id);
        await deletePositions(id);
        // Don't deactivate — fs watcher and health runners are long-lived
        // infrastructure per workspace. Relayout only invalidates the
        // extracted graph; activate() with `inProgress` guard safely
        // re-extracts and preserves existing watchers/runners.
        void ctx.activations.activate(workspace);
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
    // Fire-and-forget extraction. The hook that triggered activation returns
    // immediately; progress + graph_ready events arrive over WS.
    void ctx.activations.activate(workspace).catch((e) =>
      console.error(`[schematic] auto-activation extraction failed:`, e),
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

  // Populate arch-context on UserPromptSubmit so Claude sees what the user
  // is looking at. Only this event uses the additionalContext field.
  if (payload.event === "UserPromptSubmit") {
    const storeForCtx = ctx.nodeStores.get(workspace.id);
    if (!storeForCtx) return {};
    const additionalContext = buildArchContext({
      workspace,
      nodes: storeForCtx.all(),
      edges: storeForCtx.edges(),
    });
    return { additionalContext };
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
