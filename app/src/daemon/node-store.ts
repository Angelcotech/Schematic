// Bootstrap node store — maintains a minimal per-workspace NodeState map
// derived directly from hook events. No import parsing, no symbols, no real
// layout; Stage 6 replaces this with eager full-graph extraction.
//
// For Stage 5, this is how the frontend sees activity: every file CC touches
// becomes a node whose ai_intent reflects the latest PreToolUse/PostToolUse.

import { relative, basename, extname } from "node:path";
import type {
  AiIntent,
  Health,
  NodeKind,
  NodeState,
} from "../shared/node-state.js";
import type { HookPayload } from "../shared/hook-payload.js";
import type { Workspace } from "../shared/workspace.js";

// Random scatter for bootstrap nodes — keeps them visible on the dark
// canvas without a layout engine. Stage 7 replaces this with force-directed.
function randomPosition(): { x: number; y: number } {
  const r = 8;
  return { x: (Math.random() - 0.5) * r * 2, y: (Math.random() - 0.5) * r * 2 };
}

function languageForExt(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".ts": return "ts";
    case ".tsx": return "tsx";
    case ".js": return "js";
    case ".jsx": return "jsx";
    case ".py": return "py";
    case ".rs": return "rs";
    case ".go": return "go";
    case ".md": return "md";
    case ".json": return "json";
    default: return undefined;
  }
}

function emptyNode(id: string, absolutePath: string, kind: NodeKind): NodeState {
  const { x, y } = randomPosition();
  const lang = languageForExt(extname(absolutePath));
  const node: NodeState = {
    id,
    path: absolutePath,
    name: basename(absolutePath),
    kind,
    depth: 0,
    exports: [],
    imports: [],
    line_count: 0,
    byte_size: 0,
    x, y,
    width: 1.6,
    height: 0.8,
    manually_positioned: false,
    manually_sized: false,
    layout_locked: false,
    ai_intent: "idle",
    user_state: "none",
    in_arch_context: false,
    aggregated_ai_intent: "idle",
    aggregated_activity_count: 0,
    aggregated_activity_ts: 0,
    aggregated_health: { ok: 0, warning: 0, error: 0 },
    health: "unknown",
  };
  if (lang !== undefined) node.language = lang;
  return node;
}

// Derive ai_intent for a hook event. Read-ish tools get "reading"; write
// tools go through planning → modified/failed; Bash rm/mv → "deleted".
function intentForHook(payload: HookPayload): {
  intent: AiIntent;
  health?: Health;
} | null {
  const { event, tool } = payload;
  if (!tool) return null;

  const isReadish = tool === "Read" || tool === "Grep" || tool === "Glob";
  const isWritish = tool === "Edit" || tool === "Write" || tool === "MultiEdit";
  const isBashDelete =
    tool === "Bash" &&
    typeof payload.prompt === "string" &&
    /(^|\s)(rm|mv)\s/.test(payload.prompt);

  if (event === "PreToolUse") {
    if (isWritish) return { intent: "planning" };
    if (isReadish) return { intent: "reading" };
    return null;
  }
  if (event === "PostToolUse") {
    if (isBashDelete) return { intent: "deleted" };
    if (isWritish) {
      return payload.success === false
        ? { intent: "failed", health: "error" }
        : { intent: "modified" };
    }
    // Reads complete silently — let the reading halo decay naturally.
    return null;
  }
  // UserPromptSubmit: no per-file intent (mention extraction replaced by
  // ai_intent per efficiency pass; user-side mention signals weren't kept).
  return null;
}

interface NodeChange {
  id: string;
  node: NodeState | null; // null means "removed"
}

export class WorkspaceNodeStore {
  private readonly nodes = new Map<string, NodeState>();

  all(): NodeState[] {
    return Array.from(this.nodes.values());
  }

  get(id: string): NodeState | undefined {
    return this.nodes.get(id);
  }

  // Applies a hook event to node state, returns the change for broadcast
  // (or null if nothing meaningful changed).
  applyHook(workspace: Workspace, payload: HookPayload): NodeChange | null {
    if (!payload.target) return null;

    const derived = intentForHook(payload);
    if (!derived) return null;

    const id = relative(workspace.root, payload.target);
    if (id.startsWith("..")) return null; // target outside workspace — ignore

    let node = this.nodes.get(id);
    if (!node) {
      node = emptyNode(id, payload.target, "file");
      this.nodes.set(id, node);
    }

    node.ai_intent = derived.intent;
    node.ai_intent_since = payload.timestamp;
    node.ai_intent_tool = payload.tool ?? undefined;
    node.ai_intent_session = payload.session_id;
    node.last_ai_touch = payload.timestamp;
    if (derived.health) {
      node.health = derived.health;
      node.health_source = "ai_intent";
      node.health_updated_ts = payload.timestamp;
    }

    return { id, node: { ...node } };
  }

  // Periodic decay: demote stale non-idle nodes toward idle. Run by the
  // daemon on a timer; returns the changes so the caller can broadcast.
  applyDecay(now: number): NodeChange[] {
    const changes: NodeChange[] = [];
    for (const node of this.nodes.values()) {
      const since = node.ai_intent_since ?? 0;
      const age = now - since;
      let changed = false;

      // Reading decays fast (60s). Edits decay slower (5 min). Failed /
      // deleted stay longer so the user notices.
      const threshold =
        node.ai_intent === "reading" ? 60_000
        : node.ai_intent === "planning" ? 30_000
        : node.ai_intent === "modified" ? 300_000
        : node.ai_intent === "failed" ? 600_000
        : node.ai_intent === "deleted" ? 600_000
        : Infinity;

      if (node.ai_intent !== "idle" && age > threshold) {
        node.ai_intent = "idle";
        node.ai_intent_since = undefined;
        node.ai_intent_tool = undefined;
        node.ai_intent_session = undefined;
        changed = true;
      }

      if (changed) changes.push({ id: node.id, node: { ...node } });
    }
    return changes;
  }
}

// Per-daemon collection of per-workspace node stores.
export class NodeStoreRegistry {
  private readonly byWorkspace = new Map<string, WorkspaceNodeStore>();

  getOrCreate(workspaceId: string): WorkspaceNodeStore {
    let store = this.byWorkspace.get(workspaceId);
    if (!store) {
      store = new WorkspaceNodeStore();
      this.byWorkspace.set(workspaceId, store);
    }
    return store;
  }

  get(workspaceId: string): WorkspaceNodeStore | undefined {
    return this.byWorkspace.get(workspaceId);
  }

  drop(workspaceId: string): void {
    this.byWorkspace.delete(workspaceId);
  }

  all(): Array<[string, WorkspaceNodeStore]> {
    return Array.from(this.byWorkspace.entries());
  }
}
