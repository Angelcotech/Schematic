// File-level activity state. In the canvas world, nodes are thin visual
// references — the dynamic stuff (what CC is touching, what's failing tsc,
// etc.) lives per-file, not per-node. The frontend fans activity out to
// each canvas node that references a given file_path.
//
// Kept intentionally small. NodeState (old directory-render model) carried
// layout, kind, aggregation, symbols — all canvas concerns now.

import type { AiIntent, Health } from "./node-state.js";

export interface FileActivity {
  file_path: string;        // workspace-relative

  ai_intent: AiIntent;
  ai_intent_since?: number;
  ai_intent_tool?: string;
  ai_intent_session?: string;
  last_ai_touch?: number;

  health: Health;
  health_detail?: string;
  health_source?: string;
  health_updated_ts?: number;
}
