import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEMATIC_HOME = join(homedir(), ".schematic");
export const CONFIG_PATH = join(SCHEMATIC_HOME, "config.json");
export const WORKSPACES_REGISTRY_PATH = join(SCHEMATIC_HOME, "workspaces.json");
export const WORKSPACES_DIR = join(SCHEMATIC_HOME, "workspaces");

export function workspaceDataDir(id: string): string {
  return join(WORKSPACES_DIR, id);
}
