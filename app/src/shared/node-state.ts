export type NodeKind =
  | "file"
  | "directory"
  | "module"
  | "group"
  | "external"
  | "symbol";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "constant"
  | "method";

export type AiIntent =
  | "idle"
  | "reading"
  | "planning"
  | "modified"
  | "deleted"
  | "failed";

export type UserState = "none" | "hovered" | "selected";

export type Health = "ok" | "warning" | "error" | "unknown";

export interface AggregatedHealth {
  ok: number;
  warning: number;
  error: number;
}

export interface NodeState {
  id: string;
  path: string;
  name: string;
  kind: NodeKind;
  language?: string;
  symbol_kind?: SymbolKind;
  signature?: string;

  parent?: string;
  children?: string[];
  depth: number;

  exports: string[];
  imports: string[];
  line_count: number;
  byte_size: number;

  x: number;
  y: number;
  width: number;
  height: number;
  manually_positioned: boolean;
  manually_sized: boolean;
  layout_locked: boolean;

  ai_intent: AiIntent;
  ai_intent_since?: number;
  ai_intent_tool?: string;
  ai_intent_session?: string;

  user_state: UserState;

  in_arch_context: boolean;

  aggregated_ai_intent: "idle" | "active";
  aggregated_activity_count: number;
  aggregated_activity_ts: number;
  aggregated_health: AggregatedHealth;

  health: Health;
  health_detail?: string;
  health_source?: string;
  health_updated_ts?: number;

  last_ai_touch?: number;
  last_user_touch?: number;
  last_fs_change?: number;
}
