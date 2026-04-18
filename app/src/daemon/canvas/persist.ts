// Disk I/O for canvas files. One JSON per canvas at
//   ~/.schematic/workspaces/<wid>/canvases/<cid>.json
//
// Follows the atomic-write pattern used everywhere else in the daemon.

import { readFile, mkdir, readdir, unlink } from "node:fs/promises";
import type { CanvasFile } from "../../shared/canvas.js";
import { atomicWrite } from "../persist/atomic-write.js";
import { canvasesDir, canvasFilePath } from "../persist/paths.js";

export async function readCanvasFile(
  workspaceId: string,
  canvasId: string,
): Promise<CanvasFile> {
  const raw = await readFile(canvasFilePath(workspaceId, canvasId), "utf8");
  return JSON.parse(raw) as CanvasFile;
}

export async function writeCanvasFile(
  workspaceId: string,
  file: CanvasFile,
): Promise<void> {
  await mkdir(canvasesDir(workspaceId), { recursive: true });
  await atomicWrite(
    canvasFilePath(workspaceId, file.canvas.id),
    JSON.stringify(file, null, 2),
  );
}

export async function deleteCanvasFile(
  workspaceId: string,
  canvasId: string,
): Promise<void> {
  try {
    await unlink(canvasFilePath(workspaceId, canvasId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

// Returns every .json file id under the workspace's canvases dir.
// A missing directory is the expected first-run state and returns [].
export async function listCanvasIds(workspaceId: string): Promise<string[]> {
  try {
    const entries = await readdir(canvasesDir(workspaceId));
    return entries
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
