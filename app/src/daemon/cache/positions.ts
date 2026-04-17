// Manual node positions, kept separate from the graph cache so drags
// persist cheaply — no full graph rewrite, and the file survives
// re-extractions (which regenerate graph.json but should honor user drags
// per Invariant #6 "user-positioned nodes are sacred").

import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../persist/atomic-write.js";
import { workspaceDataDir } from "../persist/paths.js";

export interface PositionEntry {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export type PositionsMap = Record<string, PositionEntry>;

function positionsPath(workspaceId: string): string {
  return join(workspaceDataDir(workspaceId), "positions.json");
}

export async function readPositions(workspaceId: string): Promise<PositionsMap> {
  try {
    const raw = await readFile(positionsPath(workspaceId), "utf8");
    return JSON.parse(raw) as PositionsMap;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    console.warn(`[schematic] positions.json read failed for ${workspaceId}:`, (e as Error).message);
    return {};
  }
}

export async function writePositions(workspaceId: string, positions: PositionsMap): Promise<void> {
  const dir = workspaceDataDir(workspaceId);
  await mkdir(dir, { recursive: true });
  await atomicWrite(positionsPath(workspaceId), JSON.stringify(positions, null, 2));
}

export async function deletePositions(workspaceId: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(positionsPath(workspaceId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
