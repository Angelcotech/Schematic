// Live NodeState map driven by WebSocket events. The render loop subscribes
// to this store; any change flips a dirty flag and requests a frame.

import type { NodeState } from "@shared/node-state.js";
import type { SchematicEvent } from "@shared/event.js";

export type StoreChange = { kind: "replaced" } | { kind: "delta" };

export class GraphStore {
  private readonly nodes = new Map<string, NodeState>();
  private listeners: Array<(change: StoreChange) => void> = [];

  subscribe(fn: (change: StoreChange) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private notify(change: StoreChange): void {
    for (const fn of this.listeners) fn(change);
  }

  all(): NodeState[] {
    return Array.from(this.nodes.values());
  }

  get(id: string): NodeState | undefined {
    return this.nodes.get(id);
  }

  // Replace the full node set — used on initial bootstrap and on workspace
  // switch. Triggers a full rebuild downstream.
  replaceAll(nodes: NodeState[]): void {
    this.nodes.clear();
    for (const n of nodes) this.nodes.set(n.id, n);
    this.notify({ kind: "replaced" });
  }

  clear(): void {
    this.nodes.clear();
    this.notify({ kind: "replaced" });
  }

  // Apply a daemon event. Returns true if it mutated the store.
  applyEvent(event: SchematicEvent, currentWorkspaceId: string | null): boolean {
    if (event.type !== "node.state_change") return false;
    if (currentWorkspaceId !== null && event.workspace_id !== currentWorkspaceId) return false;

    if (event.node === null) {
      this.nodes.delete(event.node_id);
    } else {
      this.nodes.set(event.node_id, event.node);
    }
    this.notify({ kind: "delta" });
    return true;
  }
}
