// Shader sources for node-graph rendering.
// Stage 1: minimal rectangles (no halos/borders yet — added in Stage 2+).
// Node vertex data is plain (x, y) in data space. Edges are line segments.
// Viewport uniforms: xMin, xMax, yMin, yMax. Clip-space = -1..1.

export const NODE_VERTEX_SHADER = `#version 300 es
precision highp float;

uniform float u_xMin;
uniform float u_xMax;
uniform float u_yMin;
uniform float u_yMax;

in vec2 a_position;   // node corner in data space
in vec4 a_color;

out vec4 v_color;

void main() {
  float x = (a_position.x - u_xMin) / (u_xMax - u_xMin);
  float y = (a_position.y - u_yMin) / (u_yMax - u_yMin);
  gl_Position = vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
  v_color = a_color;
}
`;

export const NODE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 outColor;

void main() {
  outColor = v_color;
}
`;

// Edge shader reuses the same program in Stage 1. Stage 2 may diverge for
// thick lines / dashed patterns.
export const EDGE_VERTEX_SHADER = NODE_VERTEX_SHADER;
export const EDGE_FRAGMENT_SHADER = NODE_FRAGMENT_SHADER;
