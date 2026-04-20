// Per-workspace canvas store. Holds loaded canvases in memory keyed by
// canvas id; mutations write through to disk via persist.ts.
//
// Hardwire: ids from crypto.randomUUID() (collision-free, no retry loop);
// no "auto-create if missing" on read; explicit 404 semantics via
// throwNotFound; node auto-grid-placement is deterministic — the row/col is
// computed from the current node count, not random or tracked in a counter.

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import dagre from "dagre";
import type {
  Canvas,
  CanvasEdge,
  CanvasEdgeKind,
  CanvasFile,
  CanvasNode,
} from "../../shared/canvas.js";

// Shape returned by impactForFile — exported so the MCP tool layer
// (which serializes it straight to Claude) can type-check against it.
export interface ImpactEdge {
  other_file_path: string;
  other_node_id: string;
  label?: string;
  kind?: CanvasEdgeKind;
}

export interface ImpactInstance {
  canvas_id: string;
  canvas_name: string;
  node_id: string;
  process?: string;
  incoming: ImpactEdge[];
  outgoing: ImpactEdge[];
}

export interface ImpactReport {
  file_path: string;
  instances: ImpactInstance[];
  summary: {
    canvas_count: number;
    instance_count: number;
    incoming_edge_count: number;
    outgoing_edge_count: number;
    unique_incoming_files: number;
    unique_outgoing_files: number;
  };
}

export interface AuditReport {
  canvas_id: string;
  canvas_name: string;
  // Files referenced by nodes on this canvas, bucketed by disk state.
  // `missing` = no file at that path (canvas out of date or user moved/renamed).
  // `duplicates` = the same file_path appears on more than one node instance.
  //   (That's allowed by design — a file can legitimately appear multiple
  //   times on a canvas — but it's worth surfacing so Claude can decide
  //   whether it's intentional.)
  missing: Array<{ node_id: string; file_path: string }>;
  existing: Array<{ node_id: string; file_path: string }>;
  duplicates: Array<{ file_path: string; node_ids: string[] }>;
  summary: {
    node_count: number;
    missing_count: number;
    duplicate_file_count: number;
  };
}

export interface HubReport {
  canvas_id: string;
  canvas_name: string;
  threshold: number;
  hubs: Array<{
    node_id: string;
    file_path: string;
    process?: string;
    in_degree: number;
    out_degree: number;
    total_degree: number;
  }>;
}

export interface OrphanReport {
  canvas_id: string;
  canvas_name: string;
  orphans: Array<{ node_id: string; file_path: string; process?: string }>;
}

export interface CycleReport {
  canvas_id: string;
  canvas_name: string;
  cycles: Array<Array<{ node_id: string; file_path: string }>>;
}
import {
  deleteCanvasFile,
  listCanvasIds,
  readCanvasFile,
  writeCanvasFile,
} from "./persist.js";

// Auto-grid placement constants. Used when a node is added without explicit
// x, y. Tab-shaped compact defaults — the renderer is built to make small
// flat nodes read cleanly at zoom, and smaller nodes leave more room for
// edges and labels to breathe.
const AUTO_COLS = 5;
const AUTO_NODE_W = 160;
const AUTO_NODE_H = 36;
const AUTO_GAP_X = 40;
const AUTO_GAP_Y = 22;

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

// Default dagre spacing. Intentionally roomy — tight defaults caused
// overlap and edge snarl on the 40+ node canvases CC produces from
// "diagram the X repo" prompts. Exposed as overrides on autoLayout for
// power-user tuning but NOT on bulkPopulate, which keeps the default
// path dead simple.
const DAGRE_DEFAULT_NODESEP = 80;
const DAGRE_DEFAULT_RANKSEP = 150;

// Runs dagre over a CanvasFile's nodes+edges and writes new (x, y) back
// into each node in place. Mutates `file.nodes`; does NOT write to
// disk, bump updated_at, or broadcast — the caller owns those. Shared
// by `autoLayout` (standalone re-layout) and `bulkPopulate` (layout
// immediately after insert, so there's only ever one file write).
//
// Coordinate mapping: dagre uses top-left origin with CENTER-point node
// coords. Schematic uses bottom-left origin with BOTTOM-LEFT-corner
// coords. The flip pass converts after dagre.layout() returns.
function applyDagreLayout(
  file: CanvasFile,
  direction: "LR" | "TB",
  nodesep?: number,
  ranksep?: number,
): void {
  if (file.nodes.length === 0) return;

  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({
    rankdir: direction,
    nodesep: nodesep ?? DAGRE_DEFAULT_NODESEP,
    ranksep: ranksep ?? DAGRE_DEFAULT_RANKSEP,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const processes = new Set<string>();
  for (const n of file.nodes) {
    g.setNode(n.id, { width: n.width, height: n.height });
    if (n.process) processes.add(n.process);
  }
  for (const p of processes) g.setNode(`cluster_${p}`, {});
  for (const n of file.nodes) {
    if (n.process) g.setParent(n.id, `cluster_${n.process}`);
  }
  for (const e of file.edges) g.setEdge(e.src, e.dst);

  dagre.layout(g);

  // Dagre's d.y is the node's center in top-left coords. Bottom edge
  // in top-left space = d.y + d.height/2. Flip to bottom-left by
  // subtracting from the max bottom value.
  let maxBottomTopLeft = 0;
  for (const n of file.nodes) {
    const d = g.node(n.id);
    const bottomTL = d.y + d.height / 2;
    if (bottomTL > maxBottomTopLeft) maxBottomTopLeft = bottomTL;
  }
  for (const n of file.nodes) {
    const d = g.node(n.id);
    n.x = d.x - n.width / 2;
    // Bottom-left Y of this node = canvasHeight - (top-left bottom edge).
    n.y = maxBottomTopLeft - (d.y + n.height / 2);
  }
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
      try {
        const file = await readCanvasFile(workspaceId, id);
        files.set(file.canvas.id, file);
      } catch (e) {
        // One bad canvas file (corrupt JSON, partial write, mismatched
        // id) must NOT brick the whole workspace. Log and skip — every
        // other canvas stays operational. The corrupt file is still on
        // disk; the user can inspect/repair/delete it manually.
        console.error(
          `[schematic] skipping corrupt canvas ${id} in workspace ${workspaceId}: ${(e as Error).message}`,
        );
      }
    }
    return new CanvasStore(workspaceId, files);
  }

  listCanvases(): Canvas[] {
    return Array.from(this.files.values()).map((f) => f.canvas);
  }

  // Aggregate every occurrence of a file across every canvas in this
  // workspace, with each instance's neighbor edges resolved back to their
  // file_paths. Used by the trace_impact MCP tool so Claude can reason
  // about blast radius before touching a file.
  impactForFile(filePath: string): ImpactReport {
    const instances: ImpactInstance[] = [];
    let incomingEdgeCount = 0;
    let outgoingEdgeCount = 0;
    const canvasIds = new Set<string>();
    const uniqueIncomingFiles = new Set<string>();
    const uniqueOutgoingFiles = new Set<string>();

    for (const file of this.files.values()) {
      const matching = file.nodes.filter((n) => n.file_path === filePath);
      if (matching.length === 0) continue;
      canvasIds.add(file.canvas.id);

      const byNodeId = new Map<string, CanvasNode>();
      for (const n of file.nodes) byNodeId.set(n.id, n);

      for (const node of matching) {
        const incoming: ImpactEdge[] = [];
        const outgoing: ImpactEdge[] = [];
        for (const e of file.edges) {
          if (e.dst === node.id) {
            const src = byNodeId.get(e.src);
            if (!src) continue;
            incoming.push({
              other_file_path: src.file_path,
              other_node_id: src.id,
              ...(e.label !== undefined ? { label: e.label } : {}),
              ...(e.kind !== undefined ? { kind: e.kind } : {}),
            });
            uniqueIncomingFiles.add(src.file_path);
            incomingEdgeCount++;
          } else if (e.src === node.id) {
            const dst = byNodeId.get(e.dst);
            if (!dst) continue;
            outgoing.push({
              other_file_path: dst.file_path,
              other_node_id: dst.id,
              ...(e.label !== undefined ? { label: e.label } : {}),
              ...(e.kind !== undefined ? { kind: e.kind } : {}),
            });
            uniqueOutgoingFiles.add(dst.file_path);
            outgoingEdgeCount++;
          }
        }
        instances.push({
          canvas_id: file.canvas.id,
          canvas_name: file.canvas.name,
          node_id: node.id,
          ...(node.process !== undefined ? { process: node.process } : {}),
          incoming,
          outgoing,
        });
      }
    }

    return {
      file_path: filePath,
      instances,
      summary: {
        canvas_count: canvasIds.size,
        instance_count: instances.length,
        incoming_edge_count: incomingEdgeCount,
        outgoing_edge_count: outgoingEdgeCount,
        unique_incoming_files: uniqueIncomingFiles.size,
        unique_outgoing_files: uniqueOutgoingFiles.size,
      },
    };
  }

  // Walk every node on the canvas, stat its file_path against the workspace
  // root, report which files are missing (stale canvas) vs present, and
  // which file_paths appear on more than one node instance. MVP drift
  // detection — no import-graph comparison in v1.
  async auditCanvas(canvasId: string, workspaceRoot: string): Promise<AuditReport> {
    const file = this.getCanvas(canvasId);
    const missing: Array<{ node_id: string; file_path: string }> = [];
    const existing: Array<{ node_id: string; file_path: string }> = [];
    const byPath = new Map<string, string[]>();

    for (const node of file.nodes) {
      const absPath = join(workspaceRoot, node.file_path);
      let exists = false;
      try {
        await access(absPath);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) existing.push({ node_id: node.id, file_path: node.file_path });
      else missing.push({ node_id: node.id, file_path: node.file_path });

      let arr = byPath.get(node.file_path);
      if (!arr) { arr = []; byPath.set(node.file_path, arr); }
      arr.push(node.id);
    }

    const duplicates: Array<{ file_path: string; node_ids: string[] }> = [];
    for (const [fp, ids] of byPath) {
      if (ids.length > 1) duplicates.push({ file_path: fp, node_ids: ids });
    }

    return {
      canvas_id: canvasId,
      canvas_name: file.canvas.name,
      missing,
      existing,
      duplicates,
      summary: {
        node_count: file.nodes.length,
        missing_count: missing.length,
        duplicate_file_count: duplicates.length,
      },
    };
  }

  // Nodes with high in+out degree. A quick way for Claude to identify
  // keystone files — the ones that warrant extra care when changed.
  findHubs(canvasId: string, minDegree: number): HubReport {
    const file = this.getCanvas(canvasId);
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const e of file.edges) {
      outDegree.set(e.src, (outDegree.get(e.src) ?? 0) + 1);
      inDegree.set(e.dst, (inDegree.get(e.dst) ?? 0) + 1);
    }
    const hubs = file.nodes
      .map((n) => {
        const inD = inDegree.get(n.id) ?? 0;
        const outD = outDegree.get(n.id) ?? 0;
        return {
          node_id: n.id,
          file_path: n.file_path,
          ...(n.process !== undefined ? { process: n.process } : {}),
          in_degree: inD,
          out_degree: outD,
          total_degree: inD + outD,
        };
      })
      .filter((h) => h.total_degree >= minDegree)
      .sort((a, b) => b.total_degree - a.total_degree);
    return { canvas_id: canvasId, canvas_name: file.canvas.name, threshold: minDegree, hubs };
  }

  // Nodes with zero in and out edges. Either forgotten dependencies or
  // placeholders that never got wired up.
  findOrphans(canvasId: string): OrphanReport {
    const file = this.getCanvas(canvasId);
    const touched = new Set<string>();
    for (const e of file.edges) {
      touched.add(e.src);
      touched.add(e.dst);
    }
    const orphans = file.nodes
      .filter((n) => !touched.has(n.id))
      .map((n) => ({
        node_id: n.id,
        file_path: n.file_path,
        ...(n.process !== undefined ? { process: n.process } : {}),
      }));
    return { canvas_id: canvasId, canvas_name: file.canvas.name, orphans };
  }

  // All simple directed cycles on the canvas, via DFS with a recursion
  // stack. Short cycles are usually design smells (circular imports, etc).
  findCycles(canvasId: string): CycleReport {
    const file = this.getCanvas(canvasId);
    const out = new Map<string, string[]>();
    for (const e of file.edges) {
      let arr = out.get(e.src);
      if (!arr) { arr = []; out.set(e.src, arr); }
      arr.push(e.dst);
    }
    const byId = new Map<string, CanvasNode>();
    for (const n of file.nodes) byId.set(n.id, n);

    const cycles: string[][] = [];
    const seen = new Set<string>();  // globally finished nodes
    const onStack = new Set<string>();
    const stack: string[] = [];

    function dfs(nodeId: string): void {
      if (onStack.has(nodeId)) {
        // Found a cycle; extract the slice of `stack` from this node on.
        const startIdx = stack.indexOf(nodeId);
        if (startIdx >= 0) cycles.push(stack.slice(startIdx));
        return;
      }
      if (seen.has(nodeId)) return;
      onStack.add(nodeId);
      stack.push(nodeId);
      const next = out.get(nodeId) ?? [];
      for (const n of next) dfs(n);
      stack.pop();
      onStack.delete(nodeId);
      seen.add(nodeId);
    }

    for (const n of file.nodes) dfs(n.id);

    // Deduplicate — the same cycle can be discovered starting from
    // different points. Canonicalize by rotating so each cycle starts at
    // its lexicographically smallest node id.
    const deduped = new Map<string, string[]>();
    for (const cyc of cycles) {
      if (cyc.length === 0) continue;
      const minIdx = cyc.reduce((min, id, i) => (id < cyc[min] ? i : min), 0);
      const canonical = cyc.slice(minIdx).concat(cyc.slice(0, minIdx));
      deduped.set(canonical.join("→"), canonical);
    }

    return {
      canvas_id: canvasId,
      canvas_name: file.canvas.name,
      cycles: Array.from(deduped.values()).map((cyc) =>
        cyc.map((id) => {
          const node = byId.get(id);
          return {
            node_id: id,
            file_path: node?.file_path ?? "(unknown)",
          };
        }),
      ),
    };
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
    patch: { name?: string; description?: string; hidden?: boolean },
  ): Promise<Canvas> {
    const file = this.getCanvas(canvasId);
    if (patch.name !== undefined) file.canvas.name = patch.name;
    if (patch.description !== undefined) file.canvas.description = patch.description;
    if (patch.hidden !== undefined) {
      if (patch.hidden) file.canvas.hidden = true;
      else delete file.canvas.hidden;
    }
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

  // Single-shot population: create N nodes + M edges in one transaction,
  // one file write, one updated_at bump. Replaces the 40-call hailstorm
  // CC otherwise produces when authoring a canvas from scratch. Edges
  // reference nodes by the caller-supplied `client_id` (an arbitrary
  // handle like "n1"); we resolve each client_id to the node's real
  // server-assigned UUID before validating and persisting edges.
  //
  // Validation is all-or-nothing: a single bad edge (unknown src/dst)
  // aborts the whole call before anything is written. No partial state.
  async bulkPopulate(
    canvasId: string,
    input: {
      nodes: Array<{
        client_id: string;
        file_path: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        process?: string;
      }>;
      edges: Array<{
        src: string; // client_id
        dst: string; // client_id
        label?: string;
        kind?: CanvasEdgeKind;
      }>;
      // Layout to apply after inserting the nodes/edges. Default "LR"
      // (left-to-right data-flow). "none" preserves caller-supplied x/y
      // — rarely the right choice; CC's hand-picked coordinates for
      // 40-node canvases consistently produce unreadable diagrams, so
      // the default path lets dagre own placement entirely.
      layout?: "LR" | "TB" | "none";
    },
  ): Promise<{ nodes_created: number; edges_created: number }> {
    const file = this.getCanvas(canvasId);

    const clientIdToRealId = new Map<string, string>();
    const createdNodes: CanvasNode[] = [];
    const baseIndex = file.nodes.length;

    // Pass 1: build the node objects and resolve client_id → real UUID.
    // Duplicate client_ids within the same bulk call are a bug — fail loud.
    for (let i = 0; i < input.nodes.length; i++) {
      const n = input.nodes[i];
      if (clientIdToRealId.has(n.client_id)) {
        throw new Error(`duplicate client_id in bulk payload: "${n.client_id}"`);
      }
      const pos =
        n.x !== undefined && n.y !== undefined
          ? { x: n.x, y: n.y }
          : autoGridPosition(baseIndex + i);
      const realId = randomUUID();
      clientIdToRealId.set(n.client_id, realId);
      createdNodes.push({
        id: realId,
        canvas_id: canvasId,
        file_path: n.file_path,
        x: pos.x,
        y: pos.y,
        width: n.width ?? AUTO_NODE_W,
        height: n.height ?? AUTO_NODE_H,
        ...(n.process !== undefined ? { process: n.process } : {}),
      });
    }

    // Pass 2: resolve and validate all edges before touching state.
    // Edges may reference either a client_id from this bulk call OR an
    // existing node's real id (for additive bulk-populate after a canvas
    // is partially built). Unknown id → abort.
    const createdEdges: CanvasEdge[] = [];
    for (const e of input.edges) {
      const srcId = clientIdToRealId.get(e.src) ??
        (file.nodes.some((n) => n.id === e.src) ? e.src : null);
      const dstId = clientIdToRealId.get(e.dst) ??
        (file.nodes.some((n) => n.id === e.dst) ? e.dst : null);
      if (!srcId) throw new Error(`unknown src node id/client_id: "${e.src}"`);
      if (!dstId) throw new Error(`unknown dst node id/client_id: "${e.dst}"`);
      createdEdges.push({
        id: randomUUID(),
        canvas_id: canvasId,
        src: srcId,
        dst: dstId,
        ...(e.label !== undefined ? { label: e.label } : {}),
        ...(e.kind !== undefined ? { kind: e.kind } : {}),
      });
    }

    // Commit atomically: all nodes, then all edges, optionally lay out,
    // one file write.
    file.nodes.push(...createdNodes);
    file.edges.push(...createdEdges);

    const layout = input.layout ?? "LR";
    if (layout !== "none") {
      applyDagreLayout(file, layout);
    }

    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);

    return {
      nodes_created: createdNodes.length,
      edges_created: createdEdges.length,
    };
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

  // Translate every node with a matching `process` label by (dx, dy).
  // Zero-match is treated as an error — catching it silently would let a
  // typo'd process name result in an apparent no-op, which is harder to
  // debug than a loud failure.
  async moveProcess(
    canvasId: string,
    processName: string,
    dx: number,
    dy: number,
  ): Promise<{ nodes_moved: number }> {
    const file = this.getCanvas(canvasId);
    const matching = file.nodes.filter((n) => n.process === processName);
    if (matching.length === 0) {
      const e = new Error(`no nodes found with process="${processName}"`);
      (e as NodeJS.ErrnoException).code = "ENOENT";
      throw e;
    }
    for (const n of matching) {
      n.x += dx;
      n.y += dy;
    }
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
    return { nodes_moved: matching.length };
  }

  // Sugiyama layered layout via dagre. Replaces every node's (x, y) with
  // the computed position. Full overwrite by design — the tool's purpose
  // is cleanup of tangled diagrams, not preservation of prior placement.
  //
  // Compound clusters keep same-`process` nodes spatially grouped, which
  // matches the existing visual container rendering. Dagre handles cycles
  // internally via greedy FAS; no special-case needed.
  //
  // nodesep/ranksep are exposed for power-user tuning — the defaults are
  // opinionated for readability on the 10–60 node canvases CC produces
  // from typical "diagram the X" prompts.
  async autoLayout(
    canvasId: string,
    direction: "LR" | "TB" = "LR",
    nodesep?: number,
    ranksep?: number,
  ): Promise<{ nodes_laid_out: number }> {
    const file = this.getCanvas(canvasId);
    if (file.nodes.length === 0) {
      throw new Error("canvas has no nodes to lay out");
    }
    applyDagreLayout(file, direction, nodesep, ranksep);
    file.canvas.updated_at = Date.now();
    await writeCanvasFile(this.workspaceId, file);
    return { nodes_laid_out: file.nodes.length };
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
