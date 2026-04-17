// cwd → workspace routing.
//
// Walks up from the given cwd looking for a repo root (.git or
// .schematic.json). If the resolved root already has a workspace record,
// returns it. Otherwise inspects marker files to decide:
//   - .schematic-ignore  → do not activate (user opted out)
//   - .schematic.json    → ready for auto-activation
//   - bare .git only     → no record, no auto-activation
//
// Note: `.schematic/` directory is NOT a marker (it conflicts with our own
// `~/.schematic/` state directory). `.schematic.json` is the sole explicit
// auto-activation signal.

import { access } from "node:fs/promises";
import { resolve, dirname, join, basename } from "node:path";
import { createHash } from "node:crypto";
import type { Workspace } from "../../shared/workspace.js";
import type { WorkspaceRegistry } from "./registry.js";

export interface RouteResult {
  workspace: Workspace | null;
  shouldAutoActivate: boolean;
  root: string | null;
}

const REPO_MARKERS = [".schematic.json", ".git"] as const;
const IGNORE_MARKER = ".schematic-ignore";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e; // surface permission errors etc. instead of silently treating as "missing"
  }
}

interface DiscoveredRoot {
  root: string;
  hasExplicitMarker: boolean;
  hasIgnore: boolean;
}

async function findRepoRoot(startCwd: string): Promise<DiscoveredRoot | null> {
  let dir = resolve(startCwd);
  while (true) {
    for (const marker of REPO_MARKERS) {
      if (await exists(join(dir, marker))) {
        return {
          root: dir,
          hasExplicitMarker: await exists(join(dir, ".schematic.json")),
          hasIgnore: await exists(join(dir, IGNORE_MARKER)),
        };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export async function route(cwd: string, registry: WorkspaceRegistry): Promise<RouteResult> {
  const discovered = await findRepoRoot(cwd);
  if (!discovered) return { workspace: null, shouldAutoActivate: false, root: null };

  const existing = registry.findByRoot(discovered.root);
  if (existing) return { workspace: existing, shouldAutoActivate: false, root: discovered.root };

  if (discovered.hasIgnore) return { workspace: null, shouldAutoActivate: false, root: discovered.root };

  return {
    workspace: null,
    shouldAutoActivate: discovered.hasExplicitMarker,
    root: discovered.root,
  };
}

export function newWorkspace(root: string): Workspace {
  return {
    id: hashPath(root),
    root,
    name: basename(root),
    state: "active",
    created_at: Date.now(),
    last_touched_at: Date.now(),
  };
}
