// Events broadcast from the daemon. Consumed by WebSocket clients (browser)
// and future per-workspace event logs.

import type { HookPayload } from "./hook-payload.js";
import type { FileActivity } from "./file-activity.js";
import type { Workspace } from "./workspace.js";
import type { Canvas } from "./canvas.js";

export type SchematicEvent =
  | { type: "workspace.activated"; workspace: Workspace; timestamp: number }
  | { type: "workspace.paused"; workspace_id: string; timestamp: number }
  | { type: "workspace.resumed"; workspace_id: string; timestamp: number }
  | { type: "workspace.disabled"; workspace_id: string; timestamp: number }
  | { type: "workspace.forgotten"; workspace_id: string; timestamp: number }
  | {
      // Tells every browser tab which workspace to display. Fired when
      // Claude (via MCP) or the user (via CLI/UI) changes focus. v1 uses
      // a single global focus — one browser, one visible repo at a time.
      type: "workspace.focused";
      workspace_id: string;
      timestamp: number;
    }
  | { type: "hook.received"; workspace_id: string; payload: HookPayload; timestamp: number }
  | {
      // File-level activity signal. The frontend looks up all canvas nodes
      // referencing the same file_path on the active canvas and pulses them
      // together — one file change, N visual pulses if it appears in N
      // canvas nodes.
      type: "file.activity";
      workspace_id: string;
      file_path: string;
      activity: FileActivity;
      timestamp: number;
    }
  | {
      // Canvas lifecycle — so other browser tabs can refresh their canvas
      // list when a canvas is created/renamed/deleted.
      type: "canvas.created";
      workspace_id: string;
      canvas: Canvas;
      timestamp: number;
    }
  | {
      type: "canvas.updated";
      workspace_id: string;
      canvas: Canvas;
      timestamp: number;
    }
  | {
      type: "canvas.deleted";
      workspace_id: string;
      canvas_id: string;
      timestamp: number;
    }
  | {
      // Fires whenever a canvas's nodes/edges change (not metadata — use
      // canvas.updated for that). Browser debounces and re-fetches the
      // canvas so CC's incremental add_node/add_edge calls surface live.
      type: "canvas.content_changed";
      workspace_id: string;
      canvas_id: string;
      timestamp: number;
    };
