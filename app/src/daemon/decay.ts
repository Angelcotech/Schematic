// Periodic decay tick. Fixed interval per Law 1 (no dynamic scheduling or
// adaptive heuristics); an explicit clock demotes stale ai_intent values
// toward idle and broadcasts the changes.

import type { NodeStoreRegistry } from "./node-store.js";
import type { WSBroadcaster } from "./ws.js";

const TICK_INTERVAL_MS = 10_000; // every 10s, re-evaluate all stores

export function startDecayTick(
  stores: NodeStoreRegistry,
  ws: WSBroadcaster,
): () => void {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const [workspaceId, store] of stores.all()) {
      const changes = store.applyDecay(now);
      for (const change of changes) {
        ws.broadcast(
          {
            type: "node.state_change",
            workspace_id: workspaceId,
            node_id: change.id,
            node: change.node,
            timestamp: now,
          },
          workspaceId,
        );
      }
    }
  }, TICK_INTERVAL_MS);
  handle.unref(); // don't hold the event loop open for decay alone

  return () => clearInterval(handle);
}
