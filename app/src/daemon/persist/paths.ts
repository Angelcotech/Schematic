import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEMATIC_HOME = join(homedir(), ".schematic");
export const CONFIG_PATH = join(SCHEMATIC_HOME, "config.json");
export const WORKSPACES_REGISTRY_PATH = join(SCHEMATIC_HOME, "workspaces.json");
export const WORKSPACES_DIR = join(SCHEMATIC_HOME, "workspaces");

export function workspaceDataDir(id: string): string {
  return join(WORKSPACES_DIR, id);
}

// Per-workspace directory holding one JSON file per canvas. Chosen over a
// single aggregated file so concurrent edits (CC authoring, user drag) don't
// race for the whole workspace's canvas set.
export function canvasesDir(workspaceId: string): string {
  return join(workspaceDataDir(workspaceId), "canvases");
}

export function canvasFilePath(workspaceId: string, canvasId: string): string {
  return join(canvasesDir(workspaceId), `${canvasId}.json`);
}
