// Process-group rendering. Nodes with the same `process` value get a
// subtle rounded outline enclosing them + a name pill at the top-left.
// Computed client-side every frame — process membership is a property of
// canvas nodes, so grouping visuals are a pure projection of node state.
//
// Non-interactive in v1 — the group itself isn't draggable; users move
// individual nodes (or multi-select them). That keeps the mental model
// clean: processes are labels, not containers.

import type { CanvasNode } from "@shared/canvas.js";
import { dataToPixel, type ViewportState } from "../webgl/viewport.js";

const GROUP_PADDING_PX = 14;
const GROUP_HEADER_PX = 18;
// Blueprint-tinted cyan border with a darker navy fill — reads as a
// recessed panel on the navy bg, echoes the schematic/blueprint theme.
const GROUP_BORDER_COLOR = "rgba(140, 200, 235, 0.35)";
const GROUP_FILL_COLOR = "rgba(0, 12, 28, 0.30)";
const GROUP_LABEL_BG = "rgba(18, 35, 52, 0.95)";
const GROUP_LABEL_FG = "rgba(220, 235, 245, 0.95)";

// Shared pixel-rect computation. Used by both rendering and hit testing so
// the click target and the visual target stay identical as the user pans
// and zooms.
interface GroupRect {
  process: string;
  members: CanvasNode[];
  x: number;   // outer container top-left in pixels
  y: number;
  w: number;
  h: number;
}

function computeGroupRects(
  viewport: ViewportState,
  nodes: CanvasNode[],
): GroupRect[] {
  const byProcess = new Map<string, CanvasNode[]>();
  for (const n of nodes) {
    if (!n.process) continue;
    let arr = byProcess.get(n.process);
    if (!arr) { arr = []; byProcess.set(n.process, arr); }
    arr.push(n);
  }
  const rects: GroupRect[] = [];
  for (const [process, members] of byProcess) {
    let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
    for (const n of members) {
      const tl = dataToPixel(viewport, n.x, n.y + n.height);
      const br = dataToPixel(viewport, n.x + n.width, n.y);
      if (tl.px < minPx) minPx = tl.px;
      if (br.px > maxPx) maxPx = br.px;
      if (tl.py < minPy) minPy = tl.py;
      if (br.py > maxPy) maxPy = br.py;
    }
    rects.push({
      process,
      members,
      x: minPx - GROUP_PADDING_PX,
      y: minPy - GROUP_PADDING_PX - GROUP_HEADER_PX,
      w: (maxPx - minPx) + GROUP_PADDING_PX * 2,
      h: (maxPy - minPy) + GROUP_PADDING_PX * 2 + GROUP_HEADER_PX,
    });
  }
  return rects;
}

export function drawProcessGroups(
  c2d: CanvasRenderingContext2D,
  viewport: ViewportState,
  nodes: CanvasNode[],
): void {
  const rects = computeGroupRects(viewport, nodes);
  if (rects.length === 0) return;

  c2d.save();
  for (const g of rects) {
    // Translucent fill + thin border. Sits behind nodes in the layering
    // because drawProcessGroups runs before the node pass in drawOverlay.
    c2d.fillStyle = GROUP_FILL_COLOR;
    roundedRect(c2d, g.x, g.y, g.w, g.h, 10);
    c2d.fill();
    c2d.strokeStyle = GROUP_BORDER_COLOR;
    c2d.lineWidth = 1;
    c2d.stroke();

    // Process-name pill, top-left of the group.
    c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    const textW = c2d.measureText(g.process).width;
    const pillX = g.x + 8;
    const pillY = g.y + 6;
    const pillW = textW + 16;
    const pillH = 18;
    c2d.fillStyle = GROUP_LABEL_BG;
    roundedRect(c2d, pillX, pillY, pillW, pillH, 4);
    c2d.fill();
    c2d.fillStyle = GROUP_LABEL_FG;
    c2d.textAlign = "left";
    c2d.textBaseline = "middle";
    c2d.fillText(g.process, pillX + 8, pillY + pillH / 2);
  }
  c2d.restore();
}

// Hit-test for dragging a whole process group. Hits only the group's
// header pill or its thin border ring — NOT the interior. That keeps
// overlapping groups reachable: click in the empty interior of a front
// group and the click falls through to whatever is behind.
//
// The c2d parameter is used to measure the pill text so the hit zone
// exactly matches what's drawn.
const BORDER_HIT_WIDTH_PX = 8;

export function hitTestProcessGroup(
  c2d: CanvasRenderingContext2D,
  viewport: ViewportState,
  nodes: CanvasNode[],
  pixelX: number,
  pixelY: number,
): { process: string; memberIds: string[] } | null {
  const rects = computeGroupRects(viewport, nodes);

  c2d.save();
  c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  try {
    // Iterate in reverse so the most-recently-rendered (topmost) group
    // wins when hit zones overlap.
    for (let i = rects.length - 1; i >= 0; i--) {
      const g = rects[i];

      // 1. Header pill hit.
      const textW = c2d.measureText(g.process).width;
      const pillX = g.x + 8;
      const pillY = g.y + 6;
      const pillW = textW + 16;
      const pillH = 18;
      if (
        pixelX >= pillX && pixelX <= pillX + pillW &&
        pixelY >= pillY && pixelY <= pillY + pillH
      ) {
        return { process: g.process, memberIds: g.members.map((n) => n.id) };
      }

      // 2. Border-ring hit: inside the outer bbox but outside the
      // shrunken inner rect. Gives a thin frame of live hit area around
      // the rectangle, so users can grab the edge without catching the
      // whole interior.
      const inBox =
        pixelX >= g.x && pixelX <= g.x + g.w &&
        pixelY >= g.y && pixelY <= g.y + g.h;
      if (!inBox) continue;
      const inInterior =
        pixelX >= g.x + BORDER_HIT_WIDTH_PX &&
        pixelX <= g.x + g.w - BORDER_HIT_WIDTH_PX &&
        pixelY >= g.y + BORDER_HIT_WIDTH_PX &&
        pixelY <= g.y + g.h - BORDER_HIT_WIDTH_PX;
      if (!inInterior) {
        return { process: g.process, memberIds: g.members.map((n) => n.id) };
      }
    }
  } finally {
    c2d.restore();
  }
  return null;
}

function roundedRect(
  c2d: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  c2d.beginPath();
  c2d.moveTo(x + r, y);
  c2d.lineTo(x + w - r, y);
  c2d.quadraticCurveTo(x + w, y, x + w, y + r);
  c2d.lineTo(x + w, y + h - r);
  c2d.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c2d.lineTo(x + r, y + h);
  c2d.quadraticCurveTo(x, y + h, x, y + h - r);
  c2d.lineTo(x, y + r);
  c2d.quadraticCurveTo(x, y, x + r, y);
  c2d.closePath();
}
