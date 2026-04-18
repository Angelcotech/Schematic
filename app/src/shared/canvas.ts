// Canvas data model — the drafting layer that replaces the directory-render
// graph. One workspace holds N canvases; each canvas is an authored diagram
// of a repo or a specific pipeline in it. See TRANSITION_PLAN.md.
//
// Important invariants:
//   - Canvas belongs to exactly one workspace.
//   - A node identifies a file on disk by `file_path` (workspace-relative),
//     but the node IS NOT the file — the same file can appear as N nodes
//     across N canvases (or multiple times on the same canvas).
//   - Edges connect node *instances*, not files. So an edge in Canvas A does
//     not imply an edge in Canvas B even if both reference the same files.
//   - Process is a single optional label per node; a file that logically
//     belongs to two processes is represented as two nodes.

export interface Canvas {
  id: string;              // UUID
  workspace_id: string;
  name: string;
  description?: string;
  created_at: number;
  updated_at: number;
}

export interface CanvasNode {
  id: string;              // UUID; unique within canvas
  canvas_id: string;
  file_path: string;       // workspace-relative; may repeat across nodes
  x: number;               // canvas-space data coords (same convention as
  y: number;               // the existing graph layout — bottom-left origin)
  width: number;
  height: number;
  process?: string;        // at most one process label per node
}

// Fixed kind set drives edge color. "custom" escape-hatches so authors can
// use the label for semantics the fixed vocabulary doesn't cover without
// forcing us to grow the enum.
export type CanvasEdgeKind =
  | "calls"
  | "imports"
  | "reads"
  | "writes"
  | "control"
  | "custom";

export interface CanvasEdge {
  id: string;              // UUID
  canvas_id: string;
  src: string;             // CanvasNode.id
  dst: string;             // CanvasNode.id
  label?: string;          // free text
  kind?: CanvasEdgeKind;   // defaults to "custom" when absent
}

// On-disk shape: one file per canvas.
export interface CanvasFile {
  canvas: Canvas;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
