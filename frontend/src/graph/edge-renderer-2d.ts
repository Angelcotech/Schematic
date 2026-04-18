// Orthogonal edge routing + Canvas 2D drawing.
//
// Why 2D instead of WebGL: chokidar-v1 thin lines were invisible on HiDPI,
// and we need arrowheads + thickness + rounded corners that are cheap in
// 2D and annoying in WebGL. Edge counts at Schematic-scale (hundreds, not
// tens of thousands) make 2D easily fast enough every frame.
//
// Routing: axis-aligned segments only (Mermaid flowchart style). Picks
// the dominant axis (horizontal or vertical) between source and target
// centers, exits the source perpendicular on that side, enters the target
// perpendicular on the opposite side, and connects with a midpoint that
// produces 2 or 4 points. No obstacle avoidance — boxes can be dragged
// at 60fps without recomputation overhead.

import type { Edge, NodeState } from "@shared/index.js";
import { dataToPixel, type ViewportState } from "../webgl/viewport.js";

interface PixelBox {
  left: number;
  right: number;
  top: number;    // smaller py (higher on screen)
  bottom: number; // larger py
  cx: number;
  cy: number;
}

// Rough color palette. Alpha kept high so edges read against the dark WebGL
// background. Weight-based thickness is applied on top (see strokeForEdge).
const EDGE_COLOR: Record<string, string> = {
  import:         "rgba(170, 175, 185, 0.85)",
  dynamic_import: "rgba(210, 170, 110, 0.85)",
  type_only:      "rgba(140, 140, 160, 0.55)",
  side_effect:    "rgba(190, 130, 190, 0.80)",
  calls:          "rgba(110, 200, 200, 0.85)",
  extends:        "rgba(220, 200, 120, 0.85)",
  implements:     "rgba(150, 210, 130, 0.85)",
};
const EDGE_COLOR_FALLBACK = "rgba(170, 175, 185, 0.85)";

function boxOf(viewport: ViewportState, n: NodeState): PixelBox {
  // Data coords: n.x,n.y = bottom-left; width/height extend up-right.
  // In pixel space Y is flipped — top of the data rect has the *smaller* py.
  const tl = dataToPixel(viewport, n.x, n.y + n.height);
  const br = dataToPixel(viewport, n.x + n.width, n.y);
  return {
    left: tl.px,
    right: br.px,
    top: tl.py,
    bottom: br.py,
    cx: (tl.px + br.px) / 2,
    cy: (tl.py + br.py) / 2,
  };
}

type Pt = { x: number; y: number };

function routeOrthogonal(s: PixelBox, d: PixelBox): Pt[] {
  const dx = d.cx - s.cx;
  const dy = d.cy - s.cy;
  const horizontalDominant = Math.abs(dx) >= Math.abs(dy);

  if (horizontalDominant) {
    const exitX  = dx >= 0 ? s.right : s.left;
    const enterX = dx >= 0 ? d.left  : d.right;
    const startY = s.cy;
    const endY   = d.cy;
    if (Math.abs(startY - endY) < 1.5) {
      return [{ x: exitX, y: startY }, { x: enterX, y: endY }];
    }
    const midX = (exitX + enterX) / 2;
    return [
      { x: exitX,  y: startY },
      { x: midX,   y: startY },
      { x: midX,   y: endY   },
      { x: enterX, y: endY   },
    ];
  }

  // Vertical dominant. On screen, "below target" means larger py.
  const exitY  = dy >= 0 ? s.bottom : s.top;
  const enterY = dy >= 0 ? d.top    : d.bottom;
  const startX = s.cx;
  const endX   = d.cx;
  if (Math.abs(startX - endX) < 1.5) {
    return [{ x: startX, y: exitY }, { x: endX, y: enterY }];
  }
  const midY = (exitY + enterY) / 2;
  return [
    { x: startX, y: exitY  },
    { x: startX, y: midY   },
    { x: endX,   y: midY   },
    { x: endX,   y: enterY },
  ];
}

function strokeForEdge(edge: Edge): number {
  // Aggregated (tier-0) edges carry a weight = # of underlying file→file
  // imports between two modules. Scale thickness log-ishly so a 50-weight
  // edge doesn't render as a blob.
  const w = edge.weight ?? 1;
  if (w <= 1) return 1.5;
  return Math.min(5, 1.5 + Math.log2(w) * 0.8);
}

function drawArrowhead(
  c2d: CanvasRenderingContext2D,
  prev: Pt,
  tip: Pt,
  color: string,
  size: number,
): void {
  const dx = tip.x - prev.x;
  const dy = tip.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Back off the tip a hair so the arrow point sits cleanly at the box edge
  // instead of overshooting into the box.
  const tipX = tip.x;
  const tipY = tip.y;
  const baseX = tipX - ux * size;
  const baseY = tipY - uy * size;
  const perpX = -uy;
  const perpY = ux;
  const halfW = size * 0.55;

  c2d.beginPath();
  c2d.moveTo(tipX, tipY);
  c2d.lineTo(baseX + perpX * halfW, baseY + perpY * halfW);
  c2d.lineTo(baseX - perpX * halfW, baseY - perpY * halfW);
  c2d.closePath();
  c2d.fillStyle = color;
  c2d.fill();
}

export function drawEdges2D(
  c2d: CanvasRenderingContext2D,
  viewport: ViewportState,
  edges: Edge[],
  nodes: NodeState[],
): void {
  if (edges.length === 0) return;
  const byId = new Map<string, NodeState>();
  for (const n of nodes) byId.set(n.id, n);

  c2d.save();
  c2d.lineCap = "round";
  c2d.lineJoin = "round";

  for (const e of edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) continue; // edge references invalid node; skip rather than throw

    const s = boxOf(viewport, src);
    const d = boxOf(viewport, dst);
    const pts = routeOrthogonal(s, d);
    if (pts.length < 2) continue;

    const color = EDGE_COLOR[e.kind] ?? EDGE_COLOR_FALLBACK;
    const width = strokeForEdge(e);

    c2d.strokeStyle = color;
    c2d.lineWidth = width;
    c2d.beginPath();
    c2d.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c2d.lineTo(pts[i].x, pts[i].y);
    c2d.stroke();

    const tip  = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const arrowSize = Math.max(6, width * 2.8);
    drawArrowhead(c2d, prev, tip, color, arrowSize);
  }

  c2d.restore();
}

// Point-to-segment hit testing. Returns the edge whose polyline the cursor
// is closest to (within `thresholdPx`), or null. Used so the frontend can
// show the edge's label as a hover tooltip without painting a persistent
// label on the wire (which reads terribly when the dominant axis is vertical).
export function hitTestEdge(
  viewport: ViewportState,
  edges: Edge[],
  nodes: NodeState[],
  pixelX: number,
  pixelY: number,
  thresholdPx = 6,
): Edge | null {
  if (edges.length === 0) return null;
  const byId = new Map<string, NodeState>();
  for (const n of nodes) byId.set(n.id, n);

  let best: Edge | null = null;
  let bestDist = thresholdPx;
  for (const e of edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) continue;
    const pts = routeOrthogonal(boxOf(viewport, src), boxOf(viewport, dst));
    for (let i = 0; i < pts.length - 1; i++) {
      const d = pointSegmentDistance(pixelX, pixelY, pts[i], pts[i + 1]);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
  }
  return best;
}

function pointSegmentDistance(px: number, py: number, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * vx + (py - a.y) * vy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (a.x + t * vx), py - (a.y + t * vy));
}
