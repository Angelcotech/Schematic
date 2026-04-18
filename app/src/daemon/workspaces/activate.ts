// Workspace activation. In the canvas era there's no auto-extraction — CC
// authors canvases directly via MCP tools. All this does is start the
// configured health sources (tsc --watch, etc.) and broadcast their
// diagnostics as file.activity events so any canvas node referencing a
// health-affected file pulses.

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Workspace } from "../../shared/workspace.js";
import type { WSBroadcaster } from "../ws.js";
import type { FileActivityRegistry } from "../file-activity.js";
import {
  HealthSourceRunner,
  type HealthSourceConfig,
} from "../health/runner.js";

interface ActiveHandle {
  workspaceId: string;
  healthRunners: HealthSourceRunner[];
}

export class ActivationManager {
  private readonly handles = new Map<string, ActiveHandle>();
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly fileActivity: FileActivityRegistry,
    private readonly ws: WSBroadcaster,
  ) {}

  async activate(workspace: Workspace): Promise<boolean> {
    if (this.inProgress.has(workspace.id)) return false;
    if (this.handles.has(workspace.id)) return false;
    this.inProgress.add(workspace.id);

    try {
      const healthRunners = await this.startHealthSources(workspace);
      this.handles.set(workspace.id, {
        workspaceId: workspace.id,
        healthRunners,
      });
      return true;
    } finally {
      this.inProgress.delete(workspace.id);
    }
  }

  deactivate(workspaceId: string): void {
    const handle = this.handles.get(workspaceId);
    if (!handle) return;
    for (const r of handle.healthRunners) r.stop();
    this.handles.delete(workspaceId);
  }

  shutdown(): void {
    for (const handle of this.handles.values()) {
      for (const r of handle.healthRunners) r.stop();
    }
    this.handles.clear();
  }

  private async startHealthSources(workspace: Workspace): Promise<HealthSourceRunner[]> {
    const configured = await readHealthSources(workspace.root);
    if (configured.length === 0) return [];

    const runners: HealthSourceRunner[] = [];
    for (const src of configured) {
      const name = src.type === "tsc" ? "tsc" : src.name;

      const runnerCfg: HealthSourceConfig =
        src.type === "tsc"
          ? { type: "tsc", name, cwd: workspace.root, ...(src.project !== undefined && { project: src.project }) }
          : { type: "command", name, run: src.run, parser: src.parser, cwd: workspace.root };

      const covers = coverageForSource(src);

      const runner = new HealthSourceRunner(runnerCfg, (snapshot) => {
        const store = this.fileActivity.getOrCreate(workspace.id);
        // Translate absolute file paths → workspace-relative.
        const mapped: Array<{ file_path: string; severity: "error" | "warning" | "info"; message: string }> = [];
        for (const d of snapshot) {
          const rel = relative(workspace.root, d.file);
          if (rel.startsWith("..")) continue;
          mapped.push({ file_path: rel, severity: d.severity, message: d.message });
        }
        const changed = store.applyHealthSnapshot(name, covers, mapped);
        for (const filePath of changed) {
          const activity = store.get(filePath);
          if (!activity) continue;
          this.ws.broadcast(
            {
              type: "file.activity",
              workspace_id: workspace.id,
              file_path: filePath,
              activity: { ...activity },
              timestamp: Date.now(),
            },
            workspace.id,
          );
        }
      });

      runner.start();
      runners.push(runner);
      console.log(`[schematic] health: ${name} source started for ${workspace.name}`);
    }
    return runners;
  }
}

// ---------------------------------------------------------------------------
// .schematic.json health parsing
// ---------------------------------------------------------------------------

interface SchematicJsonHealth {
  sources?: Array<
    | { type: "tsc"; project?: string }
    | { type: "command"; name: string; run: string; parser: "tsc" }
  >;
}

type ConfiguredSource =
  | { type: "tsc"; project?: string }
  | { type: "command"; name: string; run: string; parser: "tsc" };

function coverageForSource(src: ConfiguredSource): (filePath: string) => boolean {
  if (src.type === "tsc") {
    return (p) => p.endsWith(".ts") || p.endsWith(".tsx");
  }
  return () => false;
}

async function readHealthSources(root: string): Promise<ConfiguredSource[]> {
  try {
    const raw = await readFile(join(root, ".schematic.json"), "utf8");
    const parsed = JSON.parse(raw) as { health?: SchematicJsonHealth };
    const sources = parsed.health?.sources;
    if (!Array.isArray(sources)) return [];
    return sources;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.warn(
      "[schematic] could not parse .schematic.json health config:",
      (e as Error).message,
    );
    return [];
  }
}
