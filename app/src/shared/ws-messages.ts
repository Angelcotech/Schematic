// WebSocket protocol between daemon and browser.
//
// Client sends subscribe messages to filter by workspace_id (omit for all).
// Server sends a "ready" message on connect, then events as they occur.

import type { SchematicEvent } from "./event.js";

export type WSClientMessage = { type: "subscribe"; workspace_id?: string };

export type WSServerMessage =
  | { type: "ready"; server_time: number }
  | { type: "event"; event: SchematicEvent };
