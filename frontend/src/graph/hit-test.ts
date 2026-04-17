// Pixel → node ID lookup. O(n) linear scan for Stage 2; a quadtree lands in
// Stage 5+ when real graphs arrive.
//
// Priority: symbols > files > modules. A click that lands inside both a file
// rectangle and the enclosing module rectangle should hit the file, because
// files are the more specific target.

import type { NodeState } from "@shared/index.js";
import { pixelToData, type ViewportState } from "../webgl/viewport.js";

const KIND_PRIORITY: Record<NodeState["kind"], number> = {
  symbol: 0,     // highest priority — smallest / most specific
  file: 1,
  directory: 2,
  module: 3,
  group: 3,
  external: 4,
};

export function hitTest(
  vp: ViewportState,
  nodes: NodeState[],
  pixelX: number,
  pixelY: number,
): NodeState | null {
  const { x, y } = pixelToData(vp, pixelX, pixelY);

  let best: NodeState | null = null;
  let bestPriority = Infinity;

  for (const n of nodes) {
    if (x < n.x || x > n.x + n.width) continue;
    if (y < n.y || y > n.y + n.height) continue;

    const p = KIND_PRIORITY[n.kind];
    if (p < bestPriority) {
      best = n;
      bestPriority = p;
    }
  }

  return best;
}
