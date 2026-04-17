// WebSocket client with deterministic reconnect.
//
// Per Build Law 1: no unbounded retry loop. Reconnect attempts use a fixed
// back-off schedule (1s, 2s, 5s, then every 10s) — the caller can observe
// connection state via `onStateChange`.

import type { SchematicEvent } from "@shared/event.js";
import type { WSServerMessage } from "@shared/ws-messages.js";

export type ConnectionState = "connecting" | "open" | "closed";

const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 10_000];

export interface WSClientOptions {
  url: string;
  workspaceId?: string;
  onEvent: (event: SchematicEvent) => void;
  onStateChange: (state: ConnectionState) => void;
}

export class DaemonWSClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private closedByUser = false;

  constructor(private readonly opts: WSClientOptions) {}

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private openSocket(): void {
    this.opts.onStateChange("connecting");
    const sock = new WebSocket(this.opts.url);
    this.socket = sock;

    sock.onopen = () => {
      this.attempt = 0;
      this.opts.onStateChange("open");
      sock.send(
        JSON.stringify(
          this.opts.workspaceId !== undefined
            ? { type: "subscribe", workspace_id: this.opts.workspaceId }
            : { type: "subscribe" },
        ),
      );
    };

    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as WSServerMessage;
      if (msg.type === "event") this.opts.onEvent(msg.event);
    };

    sock.onclose = () => {
      this.socket = null;
      this.opts.onStateChange("closed");
      if (this.closedByUser) return;
      const delay = BACKOFF_SCHEDULE_MS[
        Math.min(this.attempt, BACKOFF_SCHEDULE_MS.length - 1)
      ];
      this.attempt += 1;
      this.reconnectTimer = window.setTimeout(() => this.openSocket(), delay);
    };

    sock.onerror = () => {
      // onclose will follow; nothing to do here.
    };
  }
}
