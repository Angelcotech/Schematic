// Initial layout: modules in a horizontal row, files inside each module in
// a vertical stack. Deterministic and simple — Stage 7 replaces this with
// force-directed + user drag.

import type { NodeState } from "../../shared/node-state.js";
import type { ModuleDef } from "./modules.js";

const FILE_WIDTH = 2.2;
const FILE_HEIGHT = 0.6;
const FILE_GAP_Y = 0.15;
const MODULE_PADDING = 0.4;
const MODULE_GAP_X = 0.8;
const MODULE_LABEL_HEIGHT = 0.5;

// Returns (module-node, file-node) pairs positioned in a grid, with module
// bounds sized to wrap their children.
export function layOutModulesRow(modules: ModuleDef[]): NodeState[] {
  const out: NodeState[] = [];
  let cursorX = 0;

  for (const mod of modules) {
    const fileCount = mod.files.length;
    const innerH = fileCount * FILE_HEIGHT + Math.max(0, fileCount - 1) * FILE_GAP_Y;
    const moduleW = FILE_WIDTH + MODULE_PADDING * 2;
    const moduleH = innerH + MODULE_PADDING * 2 + MODULE_LABEL_HEIGHT;

    const moduleNode: NodeState = {
      id: mod.name,
      path: mod.name,
      name: mod.name,
      kind: "module",
      depth: 0,
      exports: [],
      imports: [],
      line_count: 0,
      byte_size: 0,
      x: cursorX,
      y: -moduleH / 2,
      width: moduleW,
      height: moduleH,
      manually_positioned: false,
      manually_sized: false,
      layout_locked: false,
      ai_intent: "idle",
      user_state: "none",
      in_arch_context: false,
      aggregated_ai_intent: "idle",
      aggregated_activity_count: 0,
      aggregated_activity_ts: 0,
      aggregated_health: { ok: 0, warning: 0, error: 0 },
      health: "unknown",
      children: mod.files.map((f) => f.relativePath),
    };
    out.push(moduleNode);

    // Files stacked top-down within the module, below the label area.
    let fileY = moduleNode.y + moduleH - MODULE_PADDING - MODULE_LABEL_HEIGHT - FILE_HEIGHT;
    for (const file of mod.files) {
      const fileNode: NodeState = {
        id: file.relativePath,
        path: file.absolutePath,
        name: basename(file.relativePath),
        kind: "file",
        depth: 1,
        exports: [],
        imports: [],
        line_count: 0, // populated when we need it (deferred)
        byte_size: file.byte_size,
        x: cursorX + MODULE_PADDING,
        y: fileY,
        width: FILE_WIDTH,
        height: FILE_HEIGHT,
        manually_positioned: false,
        manually_sized: false,
        layout_locked: false,
        ai_intent: "idle",
        user_state: "none",
        in_arch_context: false,
        aggregated_ai_intent: "idle",
        aggregated_activity_count: 0,
        aggregated_activity_ts: 0,
        aggregated_health: { ok: 0, warning: 0, error: 0 },
        health: "unknown",
        parent: mod.name,
        last_fs_change: file.mtime_ms,
      };
      if (file.language !== undefined) fileNode.language = file.language;
      out.push(fileNode);
      fileY -= FILE_HEIGHT + FILE_GAP_Y;
    }

    cursorX += moduleW + MODULE_GAP_X;
  }

  return out;
}

function basename(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}
