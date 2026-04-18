// Periodic decay tick. Fixed interval per Law 1 (no dynamic scheduling or
// adaptive heuristics); an explicit clock demotes stale ai_intent values
// toward idle and broadcasts the changes.

import type { FileActivityRegistry } from "./file-activity.js";
import type { WSBroadcaster } from "./ws.js";

const TICK_INTERVAL_MS = 10_000;

export function startDecayTick(
  fileActivity: FileActivityRegistry,
  ws: WSBroadcaster,
): () => void {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const [workspaceId, store] of fileActivity.all()) {
      const changes = store.applyDecay(now);
      for (const activity of changes) {
        ws.broadcast(
          {
            type: "file.activity",
            workspace_id: workspaceId,
            file_path: activity.file_path,
            activity,
            timestamp: now,
          },
          workspaceId,
        );
      }
    }
  }, TICK_INTERVAL_MS);
  handle.unref();

  return () => clearInterval(handle);
}
