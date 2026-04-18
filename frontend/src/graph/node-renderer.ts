// Node rendering: builds GPU buffers for node fills, halos, and selection
// borders. Three passes so halos sit behind fills and borders sit on top.
//
// Each pass is a plain triangle mesh: 6 vertices per rectangle, each vertex
// carrying (x, y, r, g, b, a). No instancing yet — Stage 2 is simple on
// purpose and ~10k vertices easily hits 60fps.

import type { AiIntent, Health, NodeState } from "@shared/index.js";
import type { GLContext } from "../webgl/renderer.js";

interface Rect {
  x: number; y: number; w: number; h: number;
  r: number; g: number; b: number; a: number;
}

export interface NodeBuffers {
  halo: GPUMesh | null;
  fill: GPUMesh;
  border: GPUMesh | null;
}

interface GPUMesh {
  vao: WebGLVertexArrayObject;
  count: number;
}

// --- Color palette (curated; no theme toggles per the "curated smooth" rule) ---

const MODULE_FILL = { r: 0.11, g: 0.11, b: 0.11, a: 1.0 };
const MODULE_BORDER = { r: 0.22, g: 0.22, b: 0.22, a: 1.0 };

// Muted slate for every file node — language is communicated via a thin
// accent strip on the left side, not the full fill. Demotes nodes visually
// so processes and edges read as the primary architecture signal.
const FILE_FILL = { r: 0.20, g: 0.20, b: 0.22, a: 1.0 };

// Language-accent strip colors (4% of node width, left side).
const LANGUAGE_ACCENT: Record<string, { r: number; g: number; b: number }> = {
  ts: { r: 0.19, g: 0.47, b: 0.78 },
  tsx: { r: 0.19, g: 0.47, b: 0.78 },
  js: { r: 0.90, g: 0.76, b: 0.23 },
  jsx: { r: 0.90, g: 0.76, b: 0.23 },
  py: { r: 0.24, g: 0.55, b: 0.57 },
  rs: { r: 0.81, g: 0.47, b: 0.29 },
  go: { r: 0.36, g: 0.70, b: 0.83 },
};
const DEFAULT_ACCENT = { r: 0.40, g: 0.40, b: 0.40 };

const HALO_BY_INTENT: Record<AiIntent, { r: number; g: number; b: number; a: number } | null> = {
  idle: null,
  reading: { r: 0.30, g: 0.65, b: 0.95, a: 0.85 },
  planning: { r: 0.98, g: 0.82, b: 0.18, a: 0.90 },
  modified: { r: 0.30, g: 0.88, b: 0.30, a: 0.90 },
  failed: { r: 0.95, g: 0.55, b: 0.15, a: 0.90 },
  deleted: { r: 0.95, g: 0.25, b: 0.25, a: 0.90 },
};

// CSS-ready color reference for the legend UI. Re-exports the same RGB
// values the WebGL shader uses so the legend always matches what you see.
function rgbCss(c: { r: number; g: number; b: number }): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

// Legend entries — grouped by shared color (e.g. .ts and .tsx both blue).
export const LEGEND_LANGUAGES: Array<{ label: string; color: string }> = [
  { label: ".ts / .tsx",  color: rgbCss(LANGUAGE_ACCENT.ts) },
  { label: ".js / .jsx",  color: rgbCss(LANGUAGE_ACCENT.js) },
  { label: ".py",         color: rgbCss(LANGUAGE_ACCENT.py) },
  { label: ".rs",         color: rgbCss(LANGUAGE_ACCENT.rs) },
  { label: ".go",         color: rgbCss(LANGUAGE_ACCENT.go) },
  { label: "other",       color: rgbCss(DEFAULT_ACCENT) },
];

export const LEGEND_HALO: Array<{ label: string; color: string }> =
  (Object.entries(HALO_BY_INTENT) as Array<[AiIntent, { r: number; g: number; b: number; a: number } | null]>)
    .filter(([, c]) => c !== null)
    .map(([intent, c]) => ({
      label: intent,
      color: rgbCss(c as { r: number; g: number; b: number }),
    }));

const HEALTH_BORDER: Record<Health, { r: number; g: number; b: number; a: number } | null> = {
  ok: null,
  warning: { r: 0.90, g: 0.60, b: 0.20, a: 1.0 },
  error: { r: 0.90, g: 0.30, b: 0.25, a: 1.0 },
  unknown: null,
};

const SELECTION_BORDER = { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };

// Halo padding. Leaves (files, symbols) use a fraction of their larger
// dimension so small nodes still get a generous attention-grabbing glow.
// Modules use a fixed absolute thickness so every module's halo reads
// the same no matter its size — a tall 42-file App module and a short
// 5-file Root module get the same visible glow ring.
const HALO_PAD_FRAC_LEAF = 0.22;
const HALO_PAD_MODULE_ABS = 0.18;
// Border ring thickness rendered as a frame of quads around the node.
const BORDER_THICK = 0.04;

// --- Rect → triangle vertex writer ---

function writeRectTriangles(out: number[], r: Rect): void {
  const { x, y, w, h, r: cr, g: cg, b: cb, a } = r;
  // Two triangles (0,1,2) and (0,2,3) for rectangle with corners BL, BR, TR, TL.
  // Rectangle anchor (x, y) is bottom-left.
  const x0 = x, y0 = y;
  const x1 = x + w, y1 = y + h;
  out.push(
    x0, y0, cr, cg, cb, a,
    x1, y0, cr, cg, cb, a,
    x1, y1, cr, cg, cb, a,
    x0, y0, cr, cg, cb, a,
    x1, y1, cr, cg, cb, a,
    x0, y1, cr, cg, cb, a,
  );
}

// Writes a hollow rectangle border as four small rects (top, bottom, left, right).
function writeRectBorder(out: number[], r: Rect, thick: number): void {
  const { x, y, w, h, r: cr, g: cg, b: cb, a } = r;
  const c = (px: number, py: number, pw: number, ph: number): Rect => ({ x: px, y: py, w: pw, h: ph, r: cr, g: cg, b: cb, a });
  writeRectTriangles(out, c(x, y, w, thick));                 // bottom
  writeRectTriangles(out, c(x, y + h - thick, w, thick));     // top
  writeRectTriangles(out, c(x, y, thick, h));                 // left
  writeRectTriangles(out, c(x + w - thick, y, thick, h));     // right
}

// --- Public API ---

export function buildNodeBuffers(ctx: GLContext, nodes: NodeState[]): NodeBuffers {
  const haloVerts: number[] = [];
  const fillVerts: number[] = [];
  const borderVerts: number[] = [];

  for (const n of nodes) {
    const fillColor = colorForNode(n);

    // Halo — painted when a file (canvas node) is in a non-idle state.
    // Module aggregation was a pre-canvas concept; each canvas node is
    // file-level and has its own ai_intent.
    const haloIntent: AiIntent | undefined = n.ai_intent !== "idle" ? n.ai_intent : undefined;
    const halo = haloIntent ? HALO_BY_INTENT[haloIntent] : null;
    if (halo) {
      const pad = n.kind === "module"
        ? HALO_PAD_MODULE_ABS
        : Math.max(n.width, n.height) * HALO_PAD_FRAC_LEAF;
      // Modules get a dimmer halo so the aggregate signal doesn't
      // overwhelm leaf-level halos when zoomed in.
      const alphaMul = n.kind === "module" ? 0.55 : 1;
      writeRectTriangles(haloVerts, {
        x: n.x - pad,
        y: n.y - pad,
        w: n.width + pad * 2,
        h: n.height + pad * 2,
        r: halo.r, g: halo.g, b: halo.b, a: halo.a * alphaMul,
      });
    }

    // Fill — main body (uniform slate for file nodes, module fill for modules).
    writeRectTriangles(fillVerts, {
      x: n.x, y: n.y, w: n.width, h: n.height,
      r: fillColor.r, g: fillColor.g, b: fillColor.b, a: fillColor.a,
    });

    // Language accent strip on the left side of file nodes. Thin colored
    // band keyed to file extension — language read at a glance, without
    // the node fill dominating the whole visual.
    if (n.kind === "file") {
      const accent = n.language ? LANGUAGE_ACCENT[n.language] ?? DEFAULT_ACCENT : DEFAULT_ACCENT;
      const stripW = Math.max(3, n.width * 0.03);
      writeRectTriangles(fillVerts, {
        x: n.x, y: n.y, w: stripW, h: n.height,
        r: accent.r, g: accent.g, b: accent.b, a: 1.0,
      });
    }

    // Border: selection wins over health (selection is a loud user signal).
    // Modules with aggregated errors get a red border as a glance signal.
    const healthBorder = HEALTH_BORDER[n.health];
    const aggErr = n.aggregated_health?.error ?? 0;
    const aggWarn = n.aggregated_health?.warning ?? 0;
    const moduleAggBorder =
      n.kind === "module" && aggErr > 0 ? HEALTH_BORDER["error"]
      : n.kind === "module" && aggWarn > 0 ? HEALTH_BORDER["warning"]
      : null;
    if (n.user_state === "selected") {
      writeRectBorder(borderVerts,
        { x: n.x, y: n.y, w: n.width, h: n.height, ...SELECTION_BORDER }, BORDER_THICK);
    } else if (healthBorder) {
      writeRectBorder(borderVerts,
        { x: n.x, y: n.y, w: n.width, h: n.height, ...healthBorder }, BORDER_THICK);
    } else if (moduleAggBorder) {
      writeRectBorder(borderVerts,
        { x: n.x, y: n.y, w: n.width, h: n.height, ...moduleAggBorder }, BORDER_THICK * 0.7);
    } else if (n.kind === "module") {
      writeRectBorder(borderVerts,
        { x: n.x, y: n.y, w: n.width, h: n.height, ...MODULE_BORDER }, BORDER_THICK * 0.5);
    }
  }

  return {
    halo: haloVerts.length > 0 ? uploadMesh(ctx, new Float32Array(haloVerts)) : null,
    fill: uploadMesh(ctx, new Float32Array(fillVerts)),
    border: borderVerts.length > 0 ? uploadMesh(ctx, new Float32Array(borderVerts)) : null,
  };
}

export function destroyNodeBuffers(ctx: GLContext, bufs: NodeBuffers): void {
  const { gl } = ctx;
  for (const m of [bufs.halo, bufs.fill, bufs.border]) {
    if (m) gl.deleteVertexArray(m.vao);
  }
}

// Returns the ordered list of draw commands (halo behind, fill middle, border in front).
export function nodeDraws(ctx: GLContext, bufs: NodeBuffers): { vao: WebGLVertexArrayObject; mode: number; count: number }[] {
  const { gl } = ctx;
  const draws: { vao: WebGLVertexArrayObject; mode: number; count: number }[] = [];
  if (bufs.halo) draws.push({ vao: bufs.halo.vao, mode: gl.TRIANGLES, count: bufs.halo.count });
  draws.push({ vao: bufs.fill.vao, mode: gl.TRIANGLES, count: bufs.fill.count });
  if (bufs.border) draws.push({ vao: bufs.border.vao, mode: gl.TRIANGLES, count: bufs.border.count });
  return draws;
}

// --- Internal helpers ---

function colorForNode(n: NodeState): { r: number; g: number; b: number; a: number } {
  if (n.kind === "module") return { ...MODULE_FILL };
  if (n.kind === "symbol") {
    switch (n.symbol_kind) {
      case "function": return { r: 0.30, g: 0.55, b: 0.45, a: 1.0 };
      case "class": return { r: 0.55, g: 0.40, b: 0.60, a: 1.0 };
      case "interface": return { r: 0.45, g: 0.45, b: 0.60, a: 1.0 };
      case "type": return { r: 0.40, g: 0.50, b: 0.55, a: 1.0 };
      case "constant": return { r: 0.50, g: 0.45, b: 0.35, a: 1.0 };
      default: return { r: 0.40, g: 0.40, b: 0.40, a: 1.0 };
    }
  }
  // File nodes: uniform muted slate. The language is shown as an accent
  // strip written separately in buildNodeBuffers, not via the fill.
  return { ...FILE_FILL };
}

function uploadMesh(ctx: GLContext, verts: Float32Array): GPUMesh {
  const { gl, attribs } = ctx;
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("[schematic] createVertexArray failed");
  gl.bindVertexArray(vao);

  const buf = gl.createBuffer();
  if (!buf) throw new Error("[schematic] createBuffer failed");
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

  const STRIDE = 6 * 4; // 6 floats per vertex (x, y, r, g, b, a)
  gl.enableVertexAttribArray(attribs.a_position);
  gl.vertexAttribPointer(attribs.a_position, 2, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(attribs.a_color);
  gl.vertexAttribPointer(attribs.a_color, 4, gl.FLOAT, false, STRIDE, 2 * 4);

  gl.bindVertexArray(null);
  return { vao, count: verts.length / 6 };
}

