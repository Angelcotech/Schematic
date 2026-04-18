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
const GROUP_BORDER_COLOR = "rgba(255, 255, 255, 0.12)";
const GROUP_FILL_COLOR = "rgba(255, 255, 255, 0.015)";
const GROUP_LABEL_BG = "rgba(30, 30, 30, 0.92)";
const GROUP_LABEL_FG = "rgba(220, 220, 220, 0.95)";

export function drawProcessGroups(
  c2d: CanvasRenderingContext2D,
  viewport: ViewportState,
  nodes: CanvasNode[],
): void {
  // Bucket nodes by process. Empty / undefined process = no group.
  const byProcess = new Map<string, CanvasNode[]>();
  for (const n of nodes) {
    if (!n.process) continue;
    let arr = byProcess.get(n.process);
    if (!arr) { arr = []; byProcess.set(n.process, arr); }
    arr.push(n);
  }
  if (byProcess.size === 0) return;

  c2d.save();
  for (const [process, members] of byProcess) {
    // Pixel-space bounding rect across all members.
    let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
    for (const n of members) {
      const tl = dataToPixel(viewport, n.x, n.y + n.height);
      const br = dataToPixel(viewport, n.x + n.width, n.y);
      if (tl.px < minPx) minPx = tl.px;
      if (br.px > maxPx) maxPx = br.px;
      if (tl.py < minPy) minPy = tl.py;
      if (br.py > maxPy) maxPy = br.py;
    }
    const x = minPx - GROUP_PADDING_PX;
    const y = minPy - GROUP_PADDING_PX - 18; // extra space above for the pill
    const w = (maxPx - minPx) + GROUP_PADDING_PX * 2;
    const h = (maxPy - minPy) + GROUP_PADDING_PX * 2 + 18;

    // Translucent fill + thin border. Sits behind nodes in the layering
    // because drawProcessGroups runs before the node pass in drawOverlay.
    c2d.fillStyle = GROUP_FILL_COLOR;
    roundedRect(c2d, x, y, w, h, 10);
    c2d.fill();
    c2d.strokeStyle = GROUP_BORDER_COLOR;
    c2d.lineWidth = 1;
    c2d.stroke();

    // Process-name pill, top-left of the group.
    c2d.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    const textW = c2d.measureText(process).width;
    const pillX = x + 8;
    const pillY = y + 6;
    const pillW = textW + 16;
    const pillH = 18;
    c2d.fillStyle = GROUP_LABEL_BG;
    roundedRect(c2d, pillX, pillY, pillW, pillH, 4);
    c2d.fill();
    c2d.fillStyle = GROUP_LABEL_FG;
    c2d.textAlign = "left";
    c2d.textBaseline = "middle";
    c2d.fillText(process, pillX + 8, pillY + pillH / 2);
  }
  c2d.restore();
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
