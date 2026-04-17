// Events broadcast from the daemon. Consumed by WebSocket clients (browser)
// and future per-workspace event logs.

import type { HookPayload } from "./hook-payload.js";
import type { NodeState } from "./node-state.js";
import type { Workspace } from "./workspace.js";

export type SchematicEvent =
  | { type: "workspace.activated"; workspace: Workspace; timestamp: number }
  | { type: "workspace.paused"; workspace_id: string; timestamp: number }
  | { type: "workspace.resumed"; workspace_id: string; timestamp: number }
  | { type: "workspace.disabled"; workspace_id: string; timestamp: number }
  | { type: "workspace.forgotten"; workspace_id: string; timestamp: number }
  | { type: "hook.received"; workspace_id: string; payload: HookPayload; timestamp: number }
  | {
      // A node appeared, was mutated, or decayed. The daemon sends the full
      // NodeState (or `null` for removals) rather than a partial diff — v1
      // keeps the wire simple; partials are a size optimization for later.
      type: "node.state_change";
      workspace_id: string;
      node_id: string;
      node: NodeState | null;
      timestamp: number;
    }
  | {
      // Streamed during extraction so the browser can show a progress bar.
      type: "workspace.extraction_progress";
      workspace_id: string;
      phase: "walk" | "modules" | "imports" | "layout" | "ready";
      processed: number;
      total: number;
      timestamp: number;
    }
  | {
      // The daemon finished (re-)extracting and the stored graph changed.
      // Browsers should re-fetch GET /workspaces/:id/graph to pick up the
      // new structure. (We don't inline the graph in the event to keep WS
      // frames small on bigger repos.)
      type: "workspace.graph_ready";
      workspace_id: string;
      node_count: number;
      edge_count: number;
      timestamp: number;
    };
