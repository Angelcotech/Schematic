// Per-workspace canvas store. Holds loaded canvases in memory keyed by
// canvas id; mutations write through to disk via persist.ts.
//
// Hardwire: ids from crypto.randomUUID() (collision-free, no retry loop);
// no "auto-create if missing" on read; explicit 404 semantics via
// throwNotFound; node auto-grid-placement is deterministic — the row/col is
// computed from the current node count, not random or tracked in a counter.

import { randomUUID } from "node:crypto";
import type {
  Canvas,
  CanvasEdge,
  CanvasEdgeKind,
  CanvasFile,
  CanvasNode,
} from "../../shared/canvas.js";
import {
  deleteCanvasFile,
  listCanvasIds,
  readCanvasFile,
  writeCanvasFile,
} from "./persist.js";

// Auto-grid placement constants. Used when a node is added without explicit
// x, y. Matches the existing node renderer's default visual sizes so the
// grid reads cleanly before any drag-reposition.
const AUTO_COLS = 5;
const AUTO_NODE_W = 180;
const AUTO_NODE_H = 50;
const AUTO_GAP_X = 40;
const AUTO_GAP_Y = 30;

function autoGridPosition(nodeIndex: number): { x: number; y: number } {
  const col = nodeIndex % AUTO_COLS;
  const row = Math.floor(nodeIndex / AUTO_COLS);
  const x = col * (AUTO_NODE_W + AUTO_GAP_X);
  // Canvas data coords are bottom-left origin (same as existing layout
  // convention), so rows grow downward == y decreases.
  const y = -row * (AUTO_NODE_H + AUTO_GAP_Y);
  return { x, y };
}

function notFound(what: string, id: string): never {
  const e = new Error(`[schematic] ${what} not found: ${id}`);
  (e as NodeJS.ErrnoException).code = "ENOENT";
  throw e;
}

export class CanvasStore {
  constructor(
    public readonly workspaceId: string,
    private files: Map<string, CanvasFile>,
  ) {}

  static async load(workspaceId: string): Promise<CanvasStore> {
    const ids = await listCanvasIds(workspaceId);
    const files = new Map<string, CanvasFile>();
    for (const id of ids) {
      const file = await readCanvasFile(workspaceId, id);
      files.set(file.canvas.id, file);
    }
    return new CanvasStore(workspaceId, files);
  }

  listCanvases(): Canvas[] {
    return Array.from(this.files.values()).map((f) => f.canvas);
  }

  getCanvas(canvasId: string): CanvasFile {
    const file = this.files.get(canvasId);
    if (!file) notFound("canvas", canvasId);
    return file;
  }

  async createCanvas(name: string, description?: string): Promise<CanvasFile> {
    const now = Date.now();
    const canvas: Canvas = {
      id: randomUUID(),
      workspace_id: this.workspaceId,
      name,
      ...(description !== undefined ? { description } : {}),
      created_at: now,
      updated_at: now,
    };
    const file: CanvasFile = { canvas, nodes: [], edges: [] };
    this.files.set(canvas.id, file);
    await writeCanvasFile(this.workspaceId, file);
    return file;
  }

  async updateCanvas(
    canvasId: string,
    patch: { name?: string; description?: string },
  ): Promise<Canvas> {
    const file = this.getCanvas(canvasId);
    if (patch.name !== undefined) file.canvas.name = patch.name;
    if (patch.description !== undefined) file.canvas.description = patch.description;
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
    return file.canvas;
  }

  async deleteCanvas(canvasId: string): Promise<void> {
    if (!this.files.has(canvasId)) notFound("canvas", canvasId);
    this.files.delete(canvasId);
    await deleteCanvasFile(this.workspaceId, canvasId);
  }

  // --- Nodes -------------------------------------------------------------

  async addNode(
    canvasId: string,
    input: {
      file_path: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      process?: string;
    },
  ): Promise<CanvasNode> {
    const file = this.getCanvas(canvasId);
    const pos =
      input.x !== undefined && input.y !== undefined
        ? { x: input.x, y: input.y }
        : autoGridPosition(file.nodes.length);
    const node: CanvasNode = {
      id: randomUUID(),
      canvas_id: canvasId,
      file_path: input.file_path,
      x: pos.x,
      y: pos.y,
      width: input.width ?? AUTO_NODE_W,
      height: input.height ?? AUTO_NODE_H,
      ...(input.process !== undefined ? { process: input.process } : {}),
    };
    file.nodes.push(node);
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
    return node;
  }

  async updateNode(
    canvasId: string,
    nodeId: string,
    patch: Partial<Pick<CanvasNode, "x" | "y" | "width" | "height" | "process" | "file_path">>,
  ): Promise<CanvasNode> {
    const file = this.getCanvas(canvasId);
    const node = file.nodes.find((n) => n.id === nodeId);
    if (!node) notFound("node", nodeId);
    if (patch.x !== undefined) node.x = patch.x;
    if (patch.y !== undefined) node.y = patch.y;
    if (patch.width !== undefined) node.width = patch.width;
    if (patch.height !== undefined) node.height = patch.height;
    if (patch.process !== undefined) {
      if (patch.process === "") delete node.process;
      else node.process = patch.process;
    }
    if (patch.file_path !== undefined) node.file_path = patch.file_path;
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
    return node;
  }

  async deleteNode(canvasId: string, nodeId: string): Promise<void> {
    const file = this.getCanvas(canvasId);
    const idx = file.nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) notFound("node", nodeId);
    file.nodes.splice(idx, 1);
    // Cascade: any edge touching this node becomes invalid, so drop them.
    // Hardwire: a dangling edge is a bug, not a state we tolerate.
    file.edges = file.edges.filter((e) => e.src !== nodeId && e.dst !== nodeId);
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
  }

  // --- Edges -------------------------------------------------------------

  async addEdge(
    canvasId: string,
    input: {
      src: string;
      dst: string;
      label?: string;
      kind?: CanvasEdgeKind;
    },
  ): Promise<CanvasEdge> {
    const file = this.getCanvas(canvasId);
    if (!file.nodes.some((n) => n.id === input.src)) notFound("src node", input.src);
    if (!file.nodes.some((n) => n.id === input.dst)) notFound("dst node", input.dst);
    const edge: CanvasEdge = {
      id: randomUUID(),
      canvas_id: canvasId,
      src: input.src,
      dst: input.dst,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    };
    file.edges.push(edge);
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
    return edge;
  }

  async updateEdge(
    canvasId: string,
    edgeId: string,
    patch: Partial<Pick<CanvasEdge, "label" | "kind">>,
  ): Promise<CanvasEdge> {
    const file = this.getCanvas(canvasId);
    const edge = file.edges.find((e) => e.id === edgeId);
    if (!edge) notFound("edge", edgeId);
    if (patch.label !== undefined) {
      if (patch.label === "") delete edge.label;
      else edge.label = patch.label;
    }
    if (patch.kind !== undefined) edge.kind = patch.kind;
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
    return edge;
  }

  async deleteEdge(canvasId: string, edgeId: string): Promise<void> {
    const file = this.getCanvas(canvasId);
    const idx = file.edges.findIndex((e) => e.id === edgeId);
    if (idx < 0) notFound("edge", edgeId);
    file.edges.splice(idx, 1);
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
  }
}

// Registry mirrors NodeStoreRegistry's shape: lazy per-workspace stores,
// load on first access, never implicitly create — the caller is expected
// to pass a valid workspace id.
export class CanvasStoreRegistry {
  private stores = new Map<string, CanvasStore>();

  async getOrLoad(workspaceId: string): Promise<CanvasStore> {
    const existing = this.stores.get(workspaceId);
    if (existing) return existing;
    const store = await CanvasStore.load(workspaceId);
    this.stores.set(workspaceId, store);
    return store;
  }

  drop(workspaceId: string): void {
    this.stores.delete(workspaceId);
  }
}
