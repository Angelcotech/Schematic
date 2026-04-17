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

export interface DaemonContext {
  registry: WorkspaceRegistry;
  ws: WSBroadcaster;
  startedAt: number;
  state: { eventCount: number };
}

export function createRequestHandler(ctx: DaemonContext): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    try {
      const { url, method } = req;
      if (!url || !method) {
        return err(res, 400, "malformed request: missing url or method");
      }

      if (method === "GET" && url === "/status") {
        return json(res, 200, {
          ok: true,
          uptime_ms: Date.now() - ctx.startedAt,
          workspaces: ctx.registry.all().length,
          events_processed: ctx.state.eventCount,
          ws_clients: ctx.ws.clientCount(),
        });
      }

      if (method === "GET" && url === "/workspaces") {
        return json(res, 200, ctx.registry.all());
      }

      if (method === "POST" && url === "/hook") {
        const body = await readBody(req);
        const payload = JSON.parse(body) as HookPayload;
        await handleHook(ctx, payload);
        return json(res, 200, { ok: true });
      }

      return err(res, 404, `unknown route: ${method} ${url}`);
    } catch (e) {
      const message = (e as Error).message;
      console.error("[schematic] request error:", e);
      return err(res, 500, message);
    }
  };
}

async function handleHook(ctx: DaemonContext, payload: HookPayload): Promise<void> {
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
  // cwds are silently ignored until explicit activation (planned for Stage 4
  // via the CLI or the browser UI's workspace list).
  if (!workspace) return;

  if (workspace.state !== "active") return;

  await ctx.registry.touch(workspace.id);
  ctx.ws.broadcast(
    { type: "hook.received", workspace_id: workspace.id, payload, timestamp: Date.now() },
    workspace.id,
  );
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
