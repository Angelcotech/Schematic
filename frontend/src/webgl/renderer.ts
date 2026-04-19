// WebGL 2 lifecycle: context init, program compilation, viewport uniforms,
// draw call dispatch. No data-specific VAOs here — node/edge buffers live in
// their own modules (graph/node-renderer.ts, graph/edge-renderer.ts) to be
// added in Stage 2.

import { NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER } from "./shaders.js";
import type { ViewportState } from "./viewport.js";

export interface GLContext {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uniforms: {
    u_xMin: WebGLUniformLocation;
    u_xMax: WebGLUniformLocation;
    u_yMin: WebGLUniformLocation;
    u_yMax: WebGLUniformLocation;
  };
  attribs: {
    a_position: number;
    a_color: number;
  };
}

export function initGL(canvas: HTMLCanvasElement): GLContext {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
  if (!gl) throw new Error("[schematic] WebGL 2 not supported in this browser");

  gl.clearColor(0.063, 0.110, 0.180, 1.0); // #101c2e — dark navy with headroom for recessed panels
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const program = createProgram(gl, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER);
  gl.useProgram(program);

  const getU = (name: string): WebGLUniformLocation => {
    const loc = gl.getUniformLocation(program, name);
    if (!loc) throw new Error(`[schematic] uniform not found: ${name}`);
    return loc;
  };

  return {
    canvas,
    gl,
    program,
    uniforms: {
      u_xMin: getU("u_xMin"),
      u_xMax: getU("u_xMax"),
      u_yMin: getU("u_yMin"),
      u_yMax: getU("u_yMax"),
    },
    attribs: {
      a_position: gl.getAttribLocation(program, "a_position"),
      a_color: gl.getAttribLocation(program, "a_color"),
    },
  };
}

export function resizeCanvas(ctx: GLContext): void {
  const { canvas, gl } = ctx;
  const dpr = window.devicePixelRatio;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    gl.viewport(0, 0, bw, bh);
  }
}

export function render(
  ctx: GLContext,
  vp: ViewportState,
  draws: { vao: WebGLVertexArrayObject; mode: number; count: number }[],
): void {
  const { gl, uniforms } = ctx;

  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform1f(uniforms.u_xMin, vp.xMin);
  gl.uniform1f(uniforms.u_xMax, vp.xMax);
  gl.uniform1f(uniforms.u_yMin, vp.yMin);
  gl.uniform1f(uniforms.u_yMax, vp.yMax);

  for (const { vao, mode, count } of draws) {
    gl.bindVertexArray(vao);
    gl.drawArrays(mode, 0, count);
  }
  gl.bindVertexArray(null);
}

// --- internal helpers ---

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("[schematic] failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`[schematic] shader compile error: ${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("[schematic] failed to create program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`[schematic] program link error: ${log}`);
  }
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}
