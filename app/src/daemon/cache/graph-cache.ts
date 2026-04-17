// Persists an ExtractedGraph per workspace under
// ~/.schematic/workspaces/<id>/graph.json. Config-file hashing decides
// when the full re-parse is required vs. just diffing mtimes. Atomic
// writes via tmp+rename so a crash mid-persist can't corrupt the cache.

import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Edge } from "../../shared/edge.js";
import type { NodeState } from "../../shared/node-state.js";
import { atomicWrite } from "../persist/atomic-write.js";
import { WORKSPACES_DIR, workspaceDataDir } from "../persist/paths.js";

// Bumped to 2 in Stage 9: layout constants changed (module label area
// removed, files centered with symmetric padding). Old caches invalidate
// automatically so the next activation runs a fresh extraction.
const SCHEMA_VERSION = 2;

export interface CachedGraph {
  schema_version: number;
  workspace_id: string;
  extracted_at: number;
  tsconfig_hash: string | null;
  package_json_hash: string | null;
  schematic_json_hash: string | null;
  files: Record<string, { mtime_ms: number; byte_size: number }>;
  nodes: NodeState[];
  edges: Edge[];
}

async function sha256OfFile(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function configHashes(root: string): Promise<{
  tsconfig_hash: string | null;
  package_json_hash: string | null;
  schematic_json_hash: string | null;
}> {
  const [tsconfig_hash, package_json_hash, schematic_json_hash] = await Promise.all([
    sha256OfFile(join(root, "tsconfig.json")),
    sha256OfFile(join(root, "package.json")),
    sha256OfFile(join(root, ".schematic.json")),
  ]);
  return { tsconfig_hash, package_json_hash, schematic_json_hash };
}

export async function readCache(workspaceId: string): Promise<CachedGraph | null> {
  const path = join(workspaceDataDir(workspaceId), "graph.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as CachedGraph;
    if (parsed.schema_version !== SCHEMA_VERSION) return null;
    if (parsed.workspace_id !== workspaceId) return null;
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Corrupted cache: log and return null so activation falls through to a
    // full re-extraction. A corrupt cache is not a silent failure — we emit
    // a warning so the user notices if it repeats.
    console.warn(`[schematic] cache read failed for ${workspaceId}:`, (e as Error).message);
    return null;
  }
}

export async function deleteCache(workspaceId: string): Promise<void> {
  const path = join(workspaceDataDir(workspaceId), "graph.json");
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

export async function writeCache(graph: CachedGraph): Promise<void> {
  const dir = workspaceDataDir(graph.workspace_id);
  await mkdir(WORKSPACES_DIR, { recursive: true });
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, "graph.json"), JSON.stringify(graph, null, 2));
}

// Returns a list of file paths that are dirty (content changed since the
// cached snapshot) plus the set of files that were added, removed, or kept.
// mtime is an approximate freshness signal; combined with byte_size it's
// enough to catch edits that matter.
export function diffFiles(
  cached: CachedGraph,
  currentFiles: Map<string, { mtime_ms: number; byte_size: number }>,
): { dirty: string[]; added: string[]; removed: string[] } {
  const dirty: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [rel, stat] of currentFiles.entries()) {
    const prev = cached.files[rel];
    if (!prev) {
      added.push(rel);
      continue;
    }
    if (prev.mtime_ms !== stat.mtime_ms || prev.byte_size !== stat.byte_size) {
      dirty.push(rel);
    }
  }

  for (const rel of Object.keys(cached.files)) {
    if (!currentFiles.has(rel)) removed.push(rel);
  }

  return { dirty, added, removed };
}
