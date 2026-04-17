// Per-frame rollup of leaf state into parent modules. Runs in the browser
// — backend doesn't need to know aggregation rules, and computing every
// frame is trivial at Schematic-scale (~100 nodes).
//
// After this runs, module nodes have correct aggregated_ai_intent,
// aggregated_activity_count, aggregated_activity_ts, and aggregated_health.
// They also gain an `_aggregatedHaloIntent` shim (attached ad-hoc, not in
// the schema) so the renderer can use the most-recently-active child's
// halo color on the module at tier 0.

import type { AiIntent, NodeState } from "@shared/node-state.js";

// Extend NodeState locally with a render-only hint. Not persisted; not
// broadcast; not in the schema — lives only inside the frontend render
// pipeline.
export interface NodeStateWithHalo extends NodeState {
  _aggregatedHaloIntent?: AiIntent;
}

export function aggregateActivity(nodes: NodeState[]): void {
  const childrenByParent = new Map<string, NodeState[]>();
  for (const n of nodes) {
    if (!n.parent) continue;
    let arr = childrenByParent.get(n.parent);
    if (!arr) { arr = []; childrenByParent.set(n.parent, arr); }
    arr.push(n);
  }

  for (const m of nodes) {
    if (m.kind !== "module") continue;
    const node = m as NodeStateWithHalo;
    const children = childrenByParent.get(m.id) ?? [];

    let activeCount = 0;
    let latestTs = 0;
    let latestChild: NodeState | null = null;
    let okCount = 0, warnCount = 0, errCount = 0;

    for (const c of children) {
      if (c.ai_intent !== "idle") {
        activeCount++;
        const ts = c.ai_intent_since ?? 0;
        if (ts >= latestTs) { latestTs = ts; latestChild = c; }
      }
      if (c.health === "ok") okCount++;
      else if (c.health === "warning") warnCount++;
      else if (c.health === "error") errCount++;
    }

    if (activeCount > 0 && latestChild) {
      node.aggregated_ai_intent = "active";
      node.aggregated_activity_count = activeCount;
      node.aggregated_activity_ts = latestTs;
      node._aggregatedHaloIntent = latestChild.ai_intent;
    } else {
      node.aggregated_ai_intent = "idle";
      node.aggregated_activity_count = 0;
      node.aggregated_activity_ts = 0;
      delete node._aggregatedHaloIntent;
    }

    node.aggregated_health = { ok: okCount, warning: warnCount, error: errCount };
  }
}
