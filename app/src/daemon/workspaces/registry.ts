import { readFile } from "node:fs/promises";
import { WORKSPACES_REGISTRY_PATH } from "../persist/paths.js";
import { atomicWrite } from "../persist/atomic-write.js";
import { ensureSchematicHome } from "../persist/config.js";
import type { Workspace, WorkspaceState } from "../../shared/workspace.js";
import { assertTransition } from "./state-machine.js";

export class WorkspaceRegistry {
  private map = new Map<string, Workspace>();

  async load(): Promise<void> {
    try {
      const raw = await readFile(WORKSPACES_REGISTRY_PATH, "utf8");
      const list = JSON.parse(raw) as Workspace[];
      for (const ws of list) this.map.set(ws.id, ws);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // First run: empty registry is the correct initial state.
    }
  }

  async save(): Promise<void> {
    await ensureSchematicHome();
    const list = Array.from(this.map.values());
    await atomicWrite(WORKSPACES_REGISTRY_PATH, JSON.stringify(list, null, 2));
  }

  get(id: string): Workspace | undefined {
    return this.map.get(id);
  }

  findByRoot(root: string): Workspace | undefined {
    for (const ws of this.map.values()) {
      if (ws.root === root) return ws;
    }
    return undefined;
  }

  all(): Workspace[] {
    return Array.from(this.map.values());
  }

  async create(ws: Workspace): Promise<void> {
    if (this.map.has(ws.id)) {
      throw new Error(`[schematic] workspace already exists: ${ws.id}`);
    }
    this.map.set(ws.id, ws);
    await this.save();
  }

  async transition(id: string, to: WorkspaceState): Promise<Workspace> {
    const ws = this.map.get(id);
    if (!ws) throw new Error(`[schematic] workspace not found: ${id}`);
    assertTransition(ws.state, to);
    ws.state = to;
    ws.last_touched_at = Date.now();
    await this.save();
    return ws;
  }

  async touch(id: string): Promise<void> {
    const ws = this.map.get(id);
    if (!ws) throw new Error(`[schematic] workspace not found: ${id}`);
    ws.last_touched_at = Date.now();
    await this.save();
  }

  async forget(id: string): Promise<void> {
    if (!this.map.has(id)) {
      throw new Error(`[schematic] workspace not found: ${id}`);
    }
    this.map.delete(id);
    await this.save();
  }
}
