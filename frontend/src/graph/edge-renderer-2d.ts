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

// Legend entries — keyed by CanvasEdgeKind (the user-facing vocabulary),
// mapped through the old legacy Edge kind palette. Exported so the UI
// legend always matches what drawEdges2D actually paints.
export const LEGEND_EDGE_KINDS: Array<{ label: string; color: string }> = [
  { label: "calls",   color: EDGE_COLOR.calls },
  { label: "imports", color: EDGE_COLOR.import },
  { label: "reads",   color: EDGE_COLOR.type_only },
  { label: "writes",  color: EDGE_COLOR.dynamic_import },
  { label: "control", color: EDGE_COLOR.side_effect },
  { label: "custom",  color: EDGE_COLOR_FALLBACK },
];

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

// Batch route — computes polylines for every edge at once so parallel
// vertical segments can be spread into lanes. Without this, multiple edges
// that stair-route between two vertical columns stack their vertical
// segments at the same X and look like one thick wire.
//
// Each edge exits the LEFT or RIGHT side of its source/target (never top
// or bottom — label pills live there). For stairs, the midX is initially
// `(exit + enter) / 2`; we then bucket edges by rounded midX and offset
// each bucket member to its own lane so vertical segments separate.
//
// Horizontal edges (exit and enter at the same Y) aren't laned — they
// naturally line up, which is desirable when they share a source.
const LANE_BUCKET_PX = 50;
const LANE_SPACING_PX = 10;

interface EdgePlan {
  edge: Edge;
  s: PixelBox;
  d: PixelBox;
  exitX: number;
  enterX: number;
  exitY: number;
  enterY: number;
  baseMidX: number;
  isStair: boolean;
}

function planEdge(s: PixelBox, d: PixelBox, edge: Edge): EdgePlan {
  const goRight = d.cx >= s.cx;
  const exitX = goRight ? s.right : s.left;
  const enterX = goRight ? d.left : d.right;
  const exitY = s.cy;
  const enterY = d.cy;
  const isStair = Math.abs(exitY - enterY) >= 1.5;
  let baseMidX = (exitX + enterX) / 2;
  const midInsideSrc = baseMidX > s.left - 2 && baseMidX < s.right + 2;
  const midInsideDst = baseMidX > d.left - 2 && baseMidX < d.right + 2;
  if (midInsideSrc || midInsideDst) {
    baseMidX = goRight
      ? Math.max(s.right, d.right) + 30
      : Math.min(s.left, d.left) - 30;
  }
  return { edge, s, d, exitX, enterX, exitY, enterY, baseMidX, isStair };
}

function computeRoutes(
  viewport: ViewportState,
  edges: Edge[],
  nodes: NodeState[],
): Array<{ edge: Edge; pts: Pt[] }> {
  const byId = new Map<string, NodeState>();
  for (const n of nodes) byId.set(n.id, n);

  const plans: EdgePlan[] = [];
  for (const e of edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) continue;
    plans.push(planEdge(boxOf(viewport, src), boxOf(viewport, dst), e));
  }

  // Bucket stair plans by rounded baseMidX. Within a bucket, sort by
  // (s.cy, d.cy) for stable ordering, then offset each member's midX by
  // a per-lane delta. Non-stair (straight horizontal) edges skip laning.
  const buckets = new Map<number, EdgePlan[]>();
  for (const p of plans) {
    if (!p.isStair) continue;
    const key = Math.round(p.baseMidX / LANE_BUCKET_PX) * LANE_BUCKET_PX;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(p);
  }

  const finalMidX = new Map<EdgePlan, number>();
  for (const [, items] of buckets) {
    items.sort((a, b) => a.s.cy - b.s.cy || a.d.cy - b.d.cy);
    const n = items.length;
    if (n === 1) {
      finalMidX.set(items[0], items[0].baseMidX);
      continue;
    }
    // Centered spread around the bucket's base midX.
    const base = items.reduce((sum, p) => sum + p.baseMidX, 0) / n;
    const totalSpread = (n - 1) * LANE_SPACING_PX;
    const start = base - totalSpread / 2;
    for (let i = 0; i < n; i++) {
      finalMidX.set(items[i], start + i * LANE_SPACING_PX);
    }
  }

  const routes: Array<{ edge: Edge; pts: Pt[] }> = [];
  for (const p of plans) {
    if (!p.isStair) {
      routes.push({
        edge: p.edge,
        pts: [{ x: p.exitX, y: p.exitY }, { x: p.enterX, y: p.enterY }],
      });
      continue;
    }
    const midX = finalMidX.get(p) ?? p.baseMidX;
    routes.push({
      edge: p.edge,
      pts: [
        { x: p.exitX, y: p.exitY },
        { x: midX, y: p.exitY },
        { x: midX, y: p.enterY },
        { x: p.enterX, y: p.enterY },
      ],
    });
  }
  return routes;
}

function strokeForEdge(edge: Edge): number {
  // Aggregated (tier-0) edges carry a weight = # of underlying file→file
  // imports between two modules. Scale thickness log-ishly so a 50-weight
  // edge doesn't render as a blob.
  const w = edge.weight ?? 1;
  if (w <= 1) return 1.5;
  return Math.min(5, 1.5 + Math.log2(w) * 0.8);
}

// Strokes a polyline where every interior corner is replaced with a
// quadrant arc of up to `maxRadius`. The effective radius is clamped to
// half the shorter adjacent segment so short edges don't over-curve.
function drawRoundedPolyline(
  c2d: CanvasRenderingContext2D,
  pts: Pt[],
  maxRadius: number,
): void {
  c2d.beginPath();
  c2d.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const here = pts[i];
    const next = pts[i + 1];
    const inLen  = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLen = Math.hypot(next.x - here.x, next.y - here.y);
    const r = Math.min(maxRadius, inLen / 2, outLen / 2);
    c2d.arcTo(here.x, here.y, next.x, next.y, r);
  }
  c2d.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  c2d.stroke();
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

  c2d.save();
  c2d.lineCap = "round";
  c2d.lineJoin = "round";

  for (const { edge, pts } of computeRoutes(viewport, edges, nodes)) {
    if (pts.length < 2) continue;

    const color = EDGE_COLOR[edge.kind] ?? EDGE_COLOR_FALLBACK;
    const width = strokeForEdge(edge);

    c2d.strokeStyle = color;
    c2d.lineWidth = width;
    drawRoundedPolyline(c2d, pts, 8);

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

  let best: Edge | null = null;
  let bestDist = thresholdPx;
  // Use the same lane-aware routes that drawEdges2D draws, so hit targets
  // match what the user sees.
  for (const { edge, pts } of computeRoutes(viewport, edges, nodes)) {
    for (let i = 0; i < pts.length - 1; i++) {
      const d = pointSegmentDistance(pixelX, pixelY, pts[i], pts[i + 1]);
      if (d < bestDist) {
        bestDist = d;
        best = edge;
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
