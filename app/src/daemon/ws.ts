// WebSocket broadcaster. Direct-call API per Build Law 1 (no event bus
// abstraction): mutation sites call `broadcast(event, workspaceId?)` and the
// message goes out to subscribed clients immediately.

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { WSClientMessage, WSServerMessage } from "../shared/ws-messages.js";
import type { SchematicEvent } from "../shared/event.js";

interface Client {
  socket: WebSocket;
  subscribedWorkspaceId: string | null;
}

export class WSBroadcaster {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();

  constructor(httpServer: Server) {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
  }

  private handleConnection(socket: WebSocket): void {
    const client: Client = { socket, subscribedWorkspaceId: null };
    this.clients.add(client);

    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as WSClientMessage;
      if (msg.type === "subscribe") {
        client.subscribedWorkspaceId = msg.workspace_id ?? null;
      }
    });

    socket.on("close", () => {
      this.clients.delete(client);
    });

    socket.on("error", (err) => {
      console.error("[schematic] ws client error:", err);
    });

    this.send(client, { type: "ready", server_time: Date.now() });
  }

  broadcast(event: SchematicEvent, workspaceId?: string): void {
    const msg: WSServerMessage = { type: "event", event };
    for (const client of this.clients) {
      if (client.subscribedWorkspaceId !== null && workspaceId !== undefined && client.subscribedWorkspaceId !== workspaceId) {
        continue;
      }
      this.send(client, msg);
    }
  }

  private send(client: Client, msg: WSServerMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(JSON.stringify(msg));
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const client of this.clients) client.socket.close();
    this.wss.close();
  }
}
