// Mock graph data for Stage 2 — a small, realistic-looking Schematic-flavored
// node/edge set used to validate rendering, interaction, and state animation
// before real graph extraction arrives in Stage 6.

import type { Edge, NodeState } from "@shared/index.js";

function makeNode(partial: Partial<NodeState> & Pick<NodeState, "id" | "name" | "kind" | "x" | "y" | "width" | "height">): NodeState {
  return {
    id: partial.id,
    path: partial.path ?? partial.id,
    name: partial.name,
    kind: partial.kind,
    language: partial.language,
    symbol_kind: partial.symbol_kind,
    signature: partial.signature,
    parent: partial.parent,
    children: partial.children,
    depth: partial.depth ?? 0,
    exports: partial.exports ?? [],
    imports: partial.imports ?? [],
    line_count: partial.line_count ?? 0,
    byte_size: partial.byte_size ?? 0,
    x: partial.x,
    y: partial.y,
    width: partial.width,
    height: partial.height,
    manually_positioned: partial.manually_positioned ?? false,
    manually_sized: partial.manually_sized ?? false,
    layout_locked: partial.layout_locked ?? false,
    ai_intent: partial.ai_intent ?? "idle",
    ai_intent_since: partial.ai_intent_since,
    ai_intent_tool: partial.ai_intent_tool,
    ai_intent_session: partial.ai_intent_session,
    user_state: partial.user_state ?? "none",
    in_arch_context: partial.in_arch_context ?? false,
    aggregated_ai_intent: partial.aggregated_ai_intent ?? "idle",
    aggregated_activity_count: partial.aggregated_activity_count ?? 0,
    aggregated_activity_ts: partial.aggregated_activity_ts ?? 0,
    aggregated_health: partial.aggregated_health ?? { ok: 0, warning: 0, error: 0 },
    health: partial.health ?? "ok",
    health_detail: partial.health_detail,
    health_source: partial.health_source,
    health_updated_ts: partial.health_updated_ts,
    last_ai_touch: partial.last_ai_touch,
    last_user_touch: partial.last_user_touch,
    last_fs_change: partial.last_fs_change,
  };
}

// Small curated graph — three modules (Engine, Renderer, Server) with a few
// files each. Positions are hand-laid for Stage 2 rendering validation.

export const MOCK_NODES: NodeState[] = [
  // Engine module
  makeNode({ id: "engine", name: "Engine", kind: "module", x: -8, y: 3, width: 6, height: 4 }),
  makeNode({ id: "engine/parser.ts", name: "parser.ts", kind: "file", language: "ts", parent: "engine", depth: 1, x: -7.5, y: 5, width: 2, height: 0.9, line_count: 203 }),
  makeNode({ id: "engine/features.ts", name: "features.ts", kind: "file", language: "ts", parent: "engine", depth: 1, x: -5, y: 5, width: 2.2, height: 0.9, line_count: 187 }),
  makeNode({ id: "engine/vertex.ts", name: "vertex.ts", kind: "file", language: "ts", parent: "engine", depth: 1, x: -6.5, y: 3.6, width: 2, height: 0.9, line_count: 312, health: "error" }),

  // Renderer module
  makeNode({ id: "renderer", name: "Renderer", kind: "module", x: 1, y: 3, width: 6, height: 4 }),
  makeNode({ id: "renderer/viewport.ts", name: "viewport.ts", kind: "file", language: "ts", parent: "renderer", depth: 1, x: 1.5, y: 5, width: 2.2, height: 0.9, line_count: 98 }),
  makeNode({ id: "renderer/shaders.ts", name: "shaders.ts", kind: "file", language: "ts", parent: "renderer", depth: 1, x: 4, y: 5, width: 2.2, height: 0.9, line_count: 42 }),
  makeNode({ id: "renderer/main.ts", name: "main.ts", kind: "file", language: "ts", parent: "renderer", depth: 1, x: 2.7, y: 3.6, width: 2.2, height: 0.9, line_count: 145 }),

  // Server module
  makeNode({ id: "server", name: "Server", kind: "module", x: -3.5, y: -3, width: 7, height: 3.5 }),
  makeNode({ id: "server/http.ts", name: "http.ts", kind: "file", language: "ts", parent: "server", depth: 1, x: -3, y: -1.5, width: 2.2, height: 0.9, line_count: 176 }),
  makeNode({ id: "server/ws.ts", name: "ws.ts", kind: "file", language: "ts", parent: "server", depth: 1, x: -0.2, y: -1.5, width: 1.8, height: 0.9, line_count: 89, health: "warning" }),
];

export const MOCK_EDGES: Edge[] = [
  { source: "engine/parser.ts", target: "engine/vertex.ts", kind: "import", highlighted: false },
  { source: "engine/features.ts", target: "engine/vertex.ts", kind: "import", highlighted: false },
  { source: "engine/features.ts", target: "engine/parser.ts", kind: "import", highlighted: false },

  { source: "renderer/main.ts", target: "renderer/viewport.ts", kind: "import", highlighted: false },
  { source: "renderer/main.ts", target: "renderer/shaders.ts", kind: "import", highlighted: false },

  { source: "server/ws.ts", target: "server/http.ts", kind: "import", highlighted: false },
  { source: "server/http.ts", target: "engine/parser.ts", kind: "import", highlighted: false },
  { source: "server/http.ts", target: "engine/features.ts", kind: "import", highlighted: false },
  { source: "renderer/main.ts", target: "server/ws.ts", kind: "import", highlighted: false },

  { source: "renderer/viewport.ts", target: "renderer/shaders.ts", kind: "type_only", highlighted: false },
  { source: "engine/parser.ts", target: "renderer/shaders.ts", kind: "import", highlighted: false },
];
