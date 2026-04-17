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
import type { Edge } from "../shared/edge.js";
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
  private edgesList: Edge[] = [];

  all(): NodeState[] {
    return Array.from(this.nodes.values());
  }

  edges(): Edge[] {
    return this.edgesList;
  }

  get(id: string): NodeState | undefined {
    return this.nodes.get(id);
  }

  // Apply a batch of manual position updates. Flags each touched node as
  // manually_positioned so subsequent re-extractions preserve it per
  // Invariant #6 ("user-positioned nodes are sacred").
  applyPositions(positions: Array<{ node_id: string; x: number; y: number; width?: number; height?: number }>): void {
    for (const p of positions) {
      const node = this.nodes.get(p.node_id);
      if (!node) continue;
      node.x = p.x;
      node.y = p.y;
      if (p.width !== undefined) node.width = p.width;
      if (p.height !== undefined) node.height = p.height;
      node.manually_positioned = true;
      node.last_user_touch = Date.now();
    }
  }

  // Clear all `manually_positioned` flags — invoked by the re-layout
  // action so the next extraction produces fresh grid positions.
  clearManualPositions(): void {
    for (const node of this.nodes.values()) {
      node.manually_positioned = false;
      node.manually_sized = false;
    }
  }

  // Replace the graph with freshly-extracted data, preserving the
  // hot/ephemeral state (ai_intent, user_state, mentions) that bootstrap
  // hooks and user clicks have already accumulated.
  applyExtractedGraph(nodes: NodeState[], edges: Edge[]): void {
    const prevHot = new Map<string, Pick<NodeState,
      "ai_intent" | "ai_intent_since" | "ai_intent_tool" | "ai_intent_session" |
      "user_state" | "last_ai_touch" | "manually_positioned" | "x" | "y"
    >>();
    for (const n of this.nodes.values()) {
      prevHot.set(n.id, {
        ai_intent: n.ai_intent,
        ai_intent_since: n.ai_intent_since,
        ai_intent_tool: n.ai_intent_tool,
        ai_intent_session: n.ai_intent_session,
        user_state: n.user_state,
        last_ai_touch: n.last_ai_touch,
        manually_positioned: n.manually_positioned,
        x: n.x,
        y: n.y,
      });
    }

    this.nodes.clear();
    for (const n of nodes) {
      const hot = prevHot.get(n.id);
      if (hot) {
        n.ai_intent = hot.ai_intent;
        n.ai_intent_since = hot.ai_intent_since;
        n.ai_intent_tool = hot.ai_intent_tool;
        n.ai_intent_session = hot.ai_intent_session;
        n.user_state = hot.user_state;
        n.last_ai_touch = hot.last_ai_touch;
        // Preserve manual positions across re-extraction per Invariant #6.
        if (hot.manually_positioned) {
          n.manually_positioned = true;
          n.x = hot.x;
          n.y = hot.y;
        }
      }
      this.nodes.set(n.id, n);
    }
    this.edgesList = edges;
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
