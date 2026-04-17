// Events broadcast from the daemon. Consumed by WebSocket clients (browser)
// and appended to per-workspace event logs. Kept minimal in Stage 3; later
// stages add node_state_change, health.updated, etc.

import type { HookPayload } from "./hook-payload.js";
import type { Workspace } from "./workspace.js";

export type SchematicEvent =
  | { type: "workspace.activated"; workspace: Workspace; timestamp: number }
  | { type: "workspace.paused"; workspace_id: string; timestamp: number }
  | { type: "workspace.resumed"; workspace_id: string; timestamp: number }
  | { type: "workspace.disabled"; workspace_id: string; timestamp: number }
  | { type: "workspace.forgotten"; workspace_id: string; timestamp: number }
  | { type: "hook.received"; workspace_id: string; payload: HookPayload; timestamp: number };
