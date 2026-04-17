// Edge rendering: line segments between node centers.
// Stage 2 uses gl.LINES (1px lines are consistent across browsers).
// Thick lines as quad meshes are a Stage 5+ upgrade.

import type { Edge, EdgeKind, NodeState } from "@shared/index.js";
import type { GLContext } from "../webgl/renderer.js";

export interface EdgeBuffer {
  vao: WebGLVertexArrayObject;
  count: number;
}

// Per-kind colors. Import is default gray; type-only is dimmer.
const EDGE_COLOR: Record<EdgeKind, { r: number; g: number; b: number; a: number }> = {
  import: { r: 0.42, g: 0.42, b: 0.46, a: 0.9 },
  dynamic_import: { r: 0.55, g: 0.45, b: 0.30, a: 0.9 },
  type_only: { r: 0.35, g: 0.35, b: 0.42, a: 0.5 },
  side_effect: { r: 0.50, g: 0.30, b: 0.50, a: 0.8 },
  calls: { r: 0.30, g: 0.60, b: 0.60, a: 0.8 },
  extends: { r: 0.60, g: 0.55, b: 0.30, a: 0.8 },
  implements: { r: 0.40, g: 0.55, b: 0.30, a: 0.8 },
};

export function buildEdgeBuffer(
  ctx: GLContext,
  nodes: NodeState[],
  edges: Edge[],
): EdgeBuffer | null {
  const byId = new Map<string, NodeState>();
  for (const n of nodes) byId.set(n.id, n);

  const verts: number[] = [];
  for (const e of edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) {
      throw new Error(`[schematic] edge references unknown node: ${e.source} → ${e.target}`);
    }
    const c = EDGE_COLOR[e.kind];
    const x0 = src.x + src.width / 2;
    const y0 = src.y + src.height / 2;
    const x1 = dst.x + dst.width / 2;
    const y1 = dst.y + dst.height / 2;
    verts.push(x0, y0, c.r, c.g, c.b, c.a);
    verts.push(x1, y1, c.r, c.g, c.b, c.a);
  }

  if (verts.length === 0) return null;

  const { gl, attribs } = ctx;
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("[schematic] createVertexArray failed");
  gl.bindVertexArray(vao);

  const buf = gl.createBuffer();
  if (!buf) throw new Error("[schematic] createBuffer failed");
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

  const STRIDE = 6 * 4;
  gl.enableVertexAttribArray(attribs.a_position);
  gl.vertexAttribPointer(attribs.a_position, 2, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(attribs.a_color);
  gl.vertexAttribPointer(attribs.a_color, 4, gl.FLOAT, false, STRIDE, 2 * 4);

  gl.bindVertexArray(null);

  return { vao, count: verts.length / 6 };
}

export function destroyEdgeBuffer(ctx: GLContext, buf: EdgeBuffer | null): void {
  if (!buf) return;
  ctx.gl.deleteVertexArray(buf.vao);
}

export function edgeDraw(ctx: GLContext, buf: EdgeBuffer | null): { vao: WebGLVertexArrayObject; mode: number; count: number }[] {
  if (!buf) return [];
  return [{ vao: buf.vao, mode: ctx.gl.LINES, count: buf.count }];
}
