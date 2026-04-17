// Workspace activation orchestration. Loads the graph cache if valid,
// otherwise runs a full extraction. Starts the fs watcher. Broadcasts
// progress + graph_ready events. Provides `deactivate` to tear things
// down on pause / disable / forget / daemon shutdown.

import type { Workspace } from "../../shared/workspace.js";
import type { SchematicEvent } from "../../shared/event.js";
import type { WSBroadcaster } from "../ws.js";
import type { NodeStoreRegistry } from "../node-store.js";
import { extractWorkspace } from "../extraction/extract.js";
import {
  configHashes,
  readCache,
  writeCache,
  type CachedGraph,
} from "../cache/graph-cache.js";
import { readPositions, type PositionsMap } from "../cache/positions.js";
import { startWatcher, type FsChangeBatch } from "../fs-watch/watcher.js";
import type { NodeState } from "../../shared/node-state.js";

interface ActiveHandle {
  workspaceId: string;
  stopWatcher: () => void;
}

export class ActivationManager {
  private readonly handles = new Map<string, ActiveHandle>();
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly stores: NodeStoreRegistry,
    private readonly ws: WSBroadcaster,
  ) {}

  // Returns true if (re-)extraction actually ran.
  async activate(workspace: Workspace): Promise<boolean> {
    // Guard against concurrent activations of the same workspace (e.g. first
    // hook racing against the daemon's startup-time extraction).
    if (this.inProgress.has(workspace.id)) return false;
    this.inProgress.add(workspace.id);

    try {
      await this.runExtraction(workspace);

      if (!this.handles.has(workspace.id)) {
        const stop = startWatcher(workspace.root, (batch) =>
          void this.onFsChange(workspace, batch).catch((e) =>
            console.error("[schematic] fs-change extraction failed:", e),
          ),
        );
        this.handles.set(workspace.id, { workspaceId: workspace.id, stopWatcher: stop });
      }
      return true;
    } finally {
      this.inProgress.delete(workspace.id);
    }
  }

  async deactivate(workspaceId: string): Promise<void> {
    const handle = this.handles.get(workspaceId);
    if (!handle) return;
    handle.stopWatcher();
    this.handles.delete(workspaceId);
  }

  async shutdown(): Promise<void> {
    for (const handle of this.handles.values()) handle.stopWatcher();
    this.handles.clear();
  }

  private async runExtraction(workspace: Workspace): Promise<void> {
    const hashes = await configHashes(workspace.root);
    const cached = await readCache(workspace.id);
    const positions = await readPositions(workspace.id);

    if (
      cached &&
      cached.tsconfig_hash === hashes.tsconfig_hash &&
      cached.package_json_hash === hashes.package_json_hash &&
      cached.schematic_json_hash === hashes.schematic_json_hash
    ) {
      // Cache hit: restore nodes + edges. Dirty-file diffing is a later
      // optimization; for v1 we trust the cache when config is unchanged.
      const store = this.stores.getOrCreate(workspace.id);
      const withPositions = applyPositions(cached.nodes, positions);
      store.applyExtractedGraph(withPositions, cached.edges);
      this.emitReady(workspace.id, cached.nodes.length, cached.edges.length);
      return;
    }

    // Full extraction. Emit progress as each phase ticks.
    const graph = await extractWorkspace(workspace.root, (p) => {
      this.emit({
        type: "workspace.extraction_progress",
        workspace_id: workspace.id,
        phase: p.phase,
        processed: p.processed,
        total: p.total,
        timestamp: Date.now(),
      });
    });

    const store = this.stores.getOrCreate(workspace.id);
    const withPositions = applyPositions(graph.nodes, positions);
    store.applyExtractedGraph(withPositions, graph.edges);

    const persisted: CachedGraph = {
      schema_version: 1,
      workspace_id: workspace.id,
      extracted_at: Date.now(),
      tsconfig_hash: hashes.tsconfig_hash,
      package_json_hash: hashes.package_json_hash,
      schematic_json_hash: hashes.schematic_json_hash,
      files: Object.fromEntries(graph.fileStats),
      nodes: graph.nodes, // freshly extracted (no manual overrides yet)
      edges: graph.edges,
    };
    await writeCache(persisted);

    this.emitReady(workspace.id, graph.nodes.length, graph.edges.length);
  }

  private async onFsChange(workspace: Workspace, batch: FsChangeBatch): Promise<void> {
    // Simple strategy for v1: any fs change triggers a full re-extract. The
    // cache layer caps re-extraction time (<2s for Schematic-scale repos),
    // and we avoid carrying incremental-update complexity into v1.
    // Batch semantics aren't used beyond triggering the re-extract.
    void batch;
    await this.runExtraction(workspace);
  }

  private emit(event: SchematicEvent): void {
    const workspaceId = "workspace_id" in event ? event.workspace_id : undefined;
    this.ws.broadcast(event, workspaceId);
  }

  private emitReady(workspaceId: string, nodeCount: number, edgeCount: number): void {
    this.emit({
      type: "workspace.graph_ready",
      workspace_id: workspaceId,
      node_count: nodeCount,
      edge_count: edgeCount,
      timestamp: Date.now(),
    });
  }
}

// Apply stored manual overrides to freshly-extracted / cached nodes.
// Nodes present in `positions` get their x/y/w/h from disk and are marked
// manually_positioned so downstream code respects them.
function applyPositions(nodes: NodeState[], positions: PositionsMap): NodeState[] {
  return nodes.map((n) => {
    const override = positions[n.id];
    if (!override) return n;
    return {
      ...n,
      x: override.x,
      y: override.y,
      width: override.width ?? n.width,
      height: override.height ?? n.height,
      manually_positioned: true,
    };
  });
}
