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

// Edge palette tuned for the near-black blueprint bg. Six distinct hues
// for the six CanvasEdgeKinds, chosen so no two kinds read as the same
// color at a glance. "Custom" is warm beige — clearly different from the
// structural imports gray.
const EDGE_COLOR: Record<string, string> = {
  calls:          "rgba(94, 192, 229, 0.95)",   // brand cyan
  import:         "rgba(180, 195, 215, 0.85)",  // pale steel (imports)
  type_only:      "rgba(130, 220, 160, 0.90)",  // soft green (reads)
  dynamic_import: "rgba(245, 180, 80, 0.90)",   // warm orange (writes)
  side_effect:    "rgba(200, 140, 230, 0.90)",  // violet (control)
  custom:         "rgba(225, 205, 175, 0.90)",  // warm beige (custom)
  extends:        "rgba(220, 200, 120, 0.85)",  // yellow (unused by canvas kinds)
  implements:     "rgba(150, 210, 130, 0.85)",  // vestigial
};
const EDGE_COLOR_FALLBACK = "rgba(225, 205, 175, 0.90)"; // same as custom

// Legend entries — keyed by CanvasEdgeKind (the user-facing vocabulary),
// mapped through the internal palette. Exported so the UI legend always
// matches what drawEdges2D paints.
export const LEGEND_EDGE_KINDS: Array<{ label: string; color: string }> = [
  { label: "calls",   color: EDGE_COLOR.calls },
  { label: "imports", color: EDGE_COLOR.import },
  { label: "reads",   color: EDGE_COLOR.type_only },
  { label: "writes",  color: EDGE_COLOR.dynamic_import },
  { label: "control", color: EDGE_COLOR.side_effect },
  { label: "custom",  color: EDGE_COLOR.custom },
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
// or bottom — label pills live there). Per-edge Y attachments come from
// the slot map computed by computeNodeAttachments so arrows don't pile
// up on the same spot.
const LANE_BUCKET_PX = 50;
const LANE_SPACING_PX = 10;

// Per-node-side attachment spacing. Each attached edge gets its own slot
// Y so arrowheads and horizontal segments naturally separate. Node height
// auto-grows (upward from the authored y) when a side has too many edges
// to fit comfortably.
const SLOT_PADDING_DATA = 4;   // top/bottom padding inside node (data units)
const SLOT_MIN_SPACING_DATA = 10;

// The slot assignment for a single edge, expressed as Y fractions (0 =
// top of node, 1 = bottom) on the source and target sides.
interface SlotAssignment {
  srcYFrac: number;
  dstYFrac: number;
}

export interface NodeAttachments {
  slots: Map<number, SlotAssignment>;        // keyed by edge index
  effectiveHeights: Map<string, number>;     // nodeId → rendered height in data units
}

// Precomputes per-edge slot positions and per-node effective heights for
// a given frame. Returned once and reused by both drawEdges2D (for
// routing) and the node renderer (for height) so they stay in sync.
export function computeNodeAttachments(
  nodes: NodeState[],
  edges: Edge[],
): NodeAttachments {
  const byId = new Map<string, NodeState>();
  for (const n of nodes) byId.set(n.id, n);

  // Per-node, per-side collections. Each entry holds the edge index, the
  // OTHER endpoint's center-Y (for sort-to-minimize-crossings), and a
  // flag for whether this endpoint is the source or target.
  interface SideEntry { edgeIdx: number; otherCy: number; isSrc: boolean; }
  const leftOf = new Map<string, SideEntry[]>();
  const rightOf = new Map<string, SideEntry[]>();
  const push = (map: Map<string, SideEntry[]>, id: string, e: SideEntry): void => {
    let arr = map.get(id);
    if (!arr) { arr = []; map.set(id, arr); }
    arr.push(e);
  };

  edges.forEach((edge, edgeIdx) => {
    const s = byId.get(edge.source);
    const d = byId.get(edge.target);
    if (!s || !d) return;
    if (s.id === d.id) return; // self-loop; unsupported in v1
    const srcCx = s.x + s.width / 2;
    const dstCx = d.x + d.width / 2;
    const goRight = dstCx >= srcCx;
    const srcSide = goRight ? rightOf : leftOf;
    const dstSide = goRight ? leftOf : rightOf;
    push(srcSide, s.id, { edgeIdx, otherCy: d.y + d.height / 2, isSrc: true });
    push(dstSide, d.id, { edgeIdx, otherCy: s.y + s.height / 2, isSrc: false });
  });

  const slots = new Map<number, SlotAssignment>();
  const effectiveHeights = new Map<string, number>();

  // Process each node's side. Sort entries by the other endpoint's Y
  // descending — larger data-y = higher on screen (data y-up, screen
  // y-down), so the edge from the highest-on-screen endpoint takes the
  // top slot. This minimizes edge crossings.
  function processSide(entries: SideEntry[]): void {
    entries.sort((a, b) => b.otherCy - a.otherCy);
    const n = entries.length;
    entries.forEach((entry, i) => {
      const yFrac = (i + 0.5) / n;
      let a = slots.get(entry.edgeIdx);
      if (!a) {
        a = { srcYFrac: 0.5, dstYFrac: 0.5 };
        slots.set(entry.edgeIdx, a);
      }
      if (entry.isSrc) a.srcYFrac = yFrac;
      else a.dstYFrac = yFrac;
    });
  }

  for (const node of nodes) {
    const left = leftOf.get(node.id) ?? [];
    const right = rightOf.get(node.id) ?? [];
    processSide(left);
    processSide(right);

    const maxSide = Math.max(left.length, right.length);
    const required = maxSide * SLOT_MIN_SPACING_DATA + 2 * SLOT_PADDING_DATA;
    effectiveHeights.set(node.id, Math.max(node.height, required));
  }

  return { slots, effectiveHeights };
}

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

function planEdge(
  s: PixelBox,
  d: PixelBox,
  edge: Edge,
  slot: SlotAssignment,
): EdgePlan {
  const goRight = d.cx >= s.cx;
  const exitX = goRight ? s.right : s.left;
  const enterX = goRight ? d.left : d.right;
  // Map the slot fractions (0 at top of node, 1 at bottom) to pixel Y.
  // s.top is the smaller py (higher on screen); s.bottom is larger.
  const exitY = s.top + slot.srcYFrac * (s.bottom - s.top);
  const enterY = d.top + slot.dstYFrac * (d.bottom - d.top);
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
  attachments: NodeAttachments,
): Array<{ edge: Edge; pts: Pt[] }> {
  const byId = new Map<string, NodeState>();
  for (const n of nodes) byId.set(n.id, n);

  const plans: EdgePlan[] = [];
  edges.forEach((e, edgeIdx) => {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) return;
    const slot = attachments.slots.get(edgeIdx) ?? { srcYFrac: 0.5, dstYFrac: 0.5 };
    plans.push(planEdge(boxOf(viewport, src), boxOf(viewport, dst), e, slot));
  });

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
  attachments: NodeAttachments,
): void {
  if (edges.length === 0) return;

  c2d.save();
  c2d.lineCap = "round";
  c2d.lineJoin = "round";

  for (const { edge, pts } of computeRoutes(viewport, edges, nodes, attachments)) {
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
  attachments: NodeAttachments,
  pixelX: number,
  pixelY: number,
  thresholdPx = 6,
): Edge | null {
  if (edges.length === 0) return null;

  let best: Edge | null = null;
  let bestDist = thresholdPx;
  // Use the same lane-aware routes that drawEdges2D draws, so hit targets
  // match what the user sees.
  for (const { edge, pts } of computeRoutes(viewport, edges, nodes, attachments)) {
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
