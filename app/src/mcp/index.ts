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
import type { Edge } from "../shared/edge.js";
import type { NodeState } from "../shared/node-state.js";
import type { Workspace } from "../shared/workspace.js";

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

async function currentWorkspace(): Promise<Workspace | null> {
  const cwd = process.cwd();
  const resolved = await fetchOrNull<{ workspace: Workspace | null }>(
    `/resolve?cwd=${encodeURIComponent(cwd)}`,
  );
  return resolved?.workspace ?? null;
}

async function currentGraph(): Promise<{ workspace: Workspace | null; nodes: NodeState[]; edges: Edge[] } | null> {
  const ws = await currentWorkspace();
  if (!ws) return null;
  const graph = await fetchOrNull<{ nodes: NodeState[]; edges: Edge[] }>(`/workspaces/${ws.id}/graph`);
  if (!graph) return null;
  return { workspace: ws, nodes: graph.nodes, edges: graph.edges };
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
  "arch_neighbors",
  "Return the files a given node imports and the files that import it. Use this when you need to reason about a file's dependencies or blast radius inside the current workspace. node_id is a workspace-relative path like 'app/src/daemon/http.ts'.",
  { node_id: z.string() },
  async ({ node_id }) => {
    const graph = await currentGraph();
    if (!graph) {
      return daemonDownResponse(
        "Schematic daemon is not reachable. Run `schematic start`.",
      );
    }
    const imports = graph.edges.filter((e) => e.source === node_id).map((e) => e.target);
    const importedBy = graph.edges.filter((e) => e.target === node_id).map((e) => e.source);
    const payload = {
      node_id,
      workspace: graph.workspace?.name ?? null,
      imports,
      imported_by: importedBy,
      exists: graph.nodes.some((n) => n.id === node_id),
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  "arch_health",
  "Return current diagnostics (errors, warnings) for a node in the Schematic map. Stubbed until Stage 11 ships the health-source integration; for now always returns health=unknown.",
  { node_id: z.string() },
  async ({ node_id }) => {
    const graph = await currentGraph();
    if (!graph) {
      return daemonDownResponse(
        "Schematic daemon is not reachable. Run `schematic start`.",
      );
    }
    const node = graph.nodes.find((n) => n.id === node_id);
    if (!node) {
      return {
        content: [{ type: "text", text: `No node '${node_id}' in workspace '${graph.workspace?.name ?? "?"}'.` }],
      };
    }
    const payload = {
      node_id,
      health: node.health,
      health_detail: node.health_detail ?? null,
      health_source: node.health_source ?? null,
      aggregated_health: node.aggregated_health,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
