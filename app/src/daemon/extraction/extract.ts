// Top-level extraction orchestrator. Walks the repo, detects modules,
// parses imports per file, lays out, and returns the full graph.

import type { Edge } from "../../shared/edge.js";
import type { NodeState } from "../../shared/node-state.js";
import { walkWorkspace, type WalkedFile } from "./walker.js";
import { detectModules, type ModuleDef } from "./modules.js";
import { parseImports, linkImports, type FileImport } from "./imports.js";
import { layOutModulesRow } from "./layout.js";

export interface ExtractedGraph {
  nodes: NodeState[];
  edges: Edge[];
  fileStats: Map<string, { mtime_ms: number; byte_size: number }>;
}

export interface ExtractionProgress {
  phase: "walk" | "modules" | "imports" | "layout" | "ready";
  processed: number;
  total: number;
}

export type ProgressHandler = (p: ExtractionProgress) => void;

export async function extractWorkspace(
  root: string,
  onProgress?: ProgressHandler,
): Promise<ExtractedGraph> {
  onProgress?.({ phase: "walk", processed: 0, total: 0 });
  const files = await walkWorkspace(root);
  onProgress?.({ phase: "walk", processed: files.length, total: files.length });

  onProgress?.({ phase: "modules", processed: 0, total: files.length });
  const modules = await detectModules(root, files);
  onProgress?.({ phase: "modules", processed: files.length, total: files.length });

  onProgress?.({ phase: "imports", processed: 0, total: files.length });
  const perFileImports = new Map<WalkedFile, FileImport[]>();
  // parse imports sequentially but emit progress in batches of 100 to keep
  // broadcasts cheap while still keeping the browser informed on large repos
  let done = 0;
  for (const file of files) {
    const imports = await parseImports(file);
    perFileImports.set(file, imports);
    done++;
    if (done % 100 === 0) {
      onProgress?.({ phase: "imports", processed: done, total: files.length });
    }
  }
  onProgress?.({ phase: "imports", processed: files.length, total: files.length });

  // Link specifiers to actual workspace nodes.
  const byAbsPath = new Map<string, WalkedFile>();
  for (const f of files) byAbsPath.set(f.absolutePath, f);
  const linked = linkImports(byAbsPath, perFileImports);

  onProgress?.({ phase: "layout", processed: 0, total: modules.length });
  const nodes = layOutModulesRow(modules);
  onProgress?.({ phase: "layout", processed: modules.length, total: modules.length });

  const edges: Edge[] = [];
  for (const [file, imports] of linked.entries()) {
    for (const imp of imports) {
      if (!imp.resolvedNodeId) continue; // external / unresolved
      if (imp.resolvedNodeId === file.relativePath) continue; // self-import guard
      edges.push({
        source: file.relativePath,
        target: imp.resolvedNodeId,
        kind: imp.kind,
        highlighted: false,
      });
    }
  }

  const fileStats = new Map<string, { mtime_ms: number; byte_size: number }>();
  for (const f of files) fileStats.set(f.relativePath, { mtime_ms: f.mtime_ms, byte_size: f.byte_size });

  onProgress?.({ phase: "ready", processed: files.length, total: files.length });
  return { nodes, edges, fileStats };
}

// Re-exported for callers that want the module layout directly.
export type { ModuleDef };
