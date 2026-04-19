// 2D node rendering. Replaced the original WebGL triangle-mesh approach
// in favor of Canvas 2D so rounded corners, accent pills, and other
// smooth geometry land naturally (arcTo / roundRect vs triangle math).
// Node counts at Schematic-scale are small enough that 2D easily hits
// 60fps; the former WebGL buffer/VAO gymnastics bought us nothing.

import type { AiIntent, Health, NodeState } from "@shared/index.js";
import { dataToPixel, type ViewportState } from "../webgl/viewport.js";

// --- Color palette (curated; no theme toggles per "curated smooth") -------

// Muted slate-navy for file nodes. Blueprint-tinted so the fill picks up
// the canvas theme, but not so saturated that language accent strips
// fight with it. Language comes through the thin accent pill on the left.
const FILE_FILL = "rgb(38, 54, 76)";
const FILE_FILL_RGB = { r: 0.149, g: 0.212, b: 0.298 };

// Accent-pill color per language (CSS rgb strings for direct 2D draw).
const LANGUAGE_ACCENT: Record<string, string> = {
  ts:  "rgb(48, 120, 199)",
  tsx: "rgb(48, 120, 199)",
  js:  "rgb(230, 194, 59)",
  jsx: "rgb(230, 194, 59)",
  py:  "rgb(61, 140, 145)",
  rs:  "rgb(207, 120, 74)",
  go:  "rgb(92, 179, 212)",
};
const DEFAULT_ACCENT = "rgb(102, 102, 102)";

// Halo tint per ai_intent. Painted as a slightly larger, translucent
// rounded rect behind the node.
const HALO_BY_INTENT: Record<AiIntent, { rgba: string } | null> = {
  idle:     null,
  reading:  { rgba: "rgba(77, 166, 242, 0.75)" },
  planning: { rgba: "rgba(250, 209, 46, 0.85)" },
  modified: { rgba: "rgba(77, 224, 77, 0.85)" },
  failed:   { rgba: "rgba(242, 140, 38, 0.85)" },
  deleted:  { rgba: "rgba(242, 64, 64, 0.85)" },
};

const HEALTH_BORDER: Record<Health, string | null> = {
  ok:      null,
  warning: "rgba(230, 153, 51, 1)",
  error:   "rgba(230, 77, 64, 1)",
  unknown: null,
};
const SELECTION_BORDER = "rgba(255, 255, 255, 0.95)";

// --- Public API -----------------------------------------------------------

export function drawNodes2D(
  c2d: CanvasRenderingContext2D,
  viewport: ViewportState,
  nodes: NodeState[],
): void {
  if (nodes.length === 0) return;

  // Two passes so halos sit behind every node, not just the one they
  // belong to — otherwise one node's halo could get painted over by
  // another node rendered later in the list.
  c2d.save();

  // Pass 1: halos (behind).
  for (const n of nodes) {
    const intent = n.ai_intent;
    if (intent === "idle") continue;
    const halo = HALO_BY_INTENT[intent];
    if (!halo) continue;
    const tl = dataToPixel(viewport, n.x, n.y + n.height);
    const br = dataToPixel(viewport, n.x + n.width, n.y);
    const w = br.px - tl.px;
    const h = br.py - tl.py;
    if (w < 2 || h < 2) continue;
    const r = cornerRadius(w, h);
    const pad = 6;
    roundedRectPath(c2d, tl.px - pad, tl.py - pad, w + pad * 2, h + pad * 2, r + pad);
    c2d.fillStyle = halo.rgba;
    c2d.fill();
  }

  // Pass 2: node body (fill + accent + border).
  for (const n of nodes) {
    const tl = dataToPixel(viewport, n.x, n.y + n.height);
    const br = dataToPixel(viewport, n.x + n.width, n.y);
    const w = br.px - tl.px;
    const h = br.py - tl.py;
    if (w < 2 || h < 2) continue;
    const r = cornerRadius(w, h);

    // Fill
    roundedRectPath(c2d, tl.px, tl.py, w, h, r);
    c2d.fillStyle = FILE_FILL;
    c2d.fill();

    // Language accent pill on the left.
    if (n.kind === "file") {
      const accentColor = n.language ? LANGUAGE_ACCENT[n.language] ?? DEFAULT_ACCENT : DEFAULT_ACCENT;
      const inset = Math.min(3, h * 0.15);
      const accentW = Math.max(3, w * 0.04);
      const accentH = h - inset * 2;
      if (accentH > 2) {
        roundedRectPath(
          c2d,
          tl.px + inset,
          tl.py + inset,
          accentW,
          accentH,
          Math.min(2, accentW / 2),
        );
        c2d.fillStyle = accentColor;
        c2d.fill();
      }
    }

    // Border — selection beats health; health border surfaces compile
    // errors/warnings at a glance.
    const border = borderFor(n);
    if (border) {
      roundedRectPath(c2d, tl.px, tl.py, w, h, r);
      c2d.strokeStyle = border.color;
      c2d.lineWidth = border.width;
      c2d.stroke();
    }
  }

  c2d.restore();
}

function borderFor(n: NodeState): { color: string; width: number } | null {
  if (n.user_state === "selected") return { color: SELECTION_BORDER, width: 2 };
  const health = HEALTH_BORDER[n.health];
  if (health) return { color: health, width: 1.5 };
  return null;
}

function cornerRadius(wPx: number, hPx: number): number {
  // Match the "process box" feel — subtle rounding, clamped so small
  // nodes don't become pills.
  return Math.min(5, wPx / 3, hPx / 3);
}

function roundedRectPath(
  c2d: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  // Guard against radii that exceed half the smaller side (which turns
  // the path into garbage at tiny zoom).
  const safeR = Math.max(0, Math.min(r, w / 2, h / 2));
  c2d.beginPath();
  c2d.moveTo(x + safeR, y);
  c2d.lineTo(x + w - safeR, y);
  c2d.quadraticCurveTo(x + w, y, x + w, y + safeR);
  c2d.lineTo(x + w, y + h - safeR);
  c2d.quadraticCurveTo(x + w, y + h, x + w - safeR, y + h);
  c2d.lineTo(x + safeR, y + h);
  c2d.quadraticCurveTo(x, y + h, x, y + h - safeR);
  c2d.lineTo(x, y + safeR);
  c2d.quadraticCurveTo(x, y, x + safeR, y);
  c2d.closePath();
}

// --- Legend exports (used by the toolbar Legend dropdown) -----------------

export const LEGEND_LANGUAGES: Array<{ label: string; color: string }> = [
  { label: ".ts / .tsx",  color: LANGUAGE_ACCENT.ts },
  { label: ".js / .jsx",  color: LANGUAGE_ACCENT.js },
  { label: ".py",         color: LANGUAGE_ACCENT.py },
  { label: ".rs",         color: LANGUAGE_ACCENT.rs },
  { label: ".go",         color: LANGUAGE_ACCENT.go },
  { label: "other",       color: DEFAULT_ACCENT },
];

export const LEGEND_HALO: Array<{ label: string; color: string }> =
  (Object.entries(HALO_BY_INTENT) as Array<[AiIntent, { rgba: string } | null]>)
    .filter(([, c]) => c !== null)
    .map(([intent, c]) => ({ label: intent, color: (c as { rgba: string }).rgba }));

// Keep FILE_FILL_RGB exported in case some future renderer wants the 0-1
// RGB form; no current callers but this is the WebGL-friendly encoding.
export { FILE_FILL_RGB };
