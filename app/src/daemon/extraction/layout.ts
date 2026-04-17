// Initial layout: modules in a horizontal row, files inside each module in
// a vertical stack, symbols stacked inside each file. Deterministic and
// simple. Stage 7 added manual drag; this file is still the seed positions.

import type { NodeState } from "../../shared/node-state.js";
import type { ModuleDef } from "./modules.js";
import type { ExtractedSymbol } from "./symbols.js";

const FILE_WIDTH = 2.2;
const FILE_HEIGHT = 0.6;
const FILE_GAP_Y = 0.15;
const MODULE_PADDING = 0.4;
const MODULE_GAP_X = 0.8;
// No internal label area — labels render as pills ABOVE the module box.
// Files are padded symmetrically with MODULE_PADDING on top and bottom.

// Symbols are stacked inside a file's body. Heights are small in data
// units; tier-2 zoom is where they become legible on screen.
const SYMBOL_INSET_X = 0.08;
const SYMBOL_HEIGHT = 0.09;
const SYMBOL_GAP = 0.02;
const SYMBOL_TOP_INSET = 0.04; // leave room below the filename inside the file

// Returns module/file/symbol nodes positioned in a grid, with module
// bounds sized to wrap their children. Symbols live inside files.
export function layOutModulesRow(
  modules: ModuleDef[],
  symbolsByFile: Map<string, ExtractedSymbol[]>,
): NodeState[] {
  const out: NodeState[] = [];
  let cursorX = 0;

  for (const mod of modules) {
    const fileCount = mod.files.length;
    const innerH = fileCount * FILE_HEIGHT + Math.max(0, fileCount - 1) * FILE_GAP_Y;
    const moduleW = FILE_WIDTH + MODULE_PADDING * 2;
    const moduleH = innerH + MODULE_PADDING * 2;

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

    // Files stacked top-down within the module, padded symmetrically.
    let fileY = moduleNode.y + moduleH - MODULE_PADDING - FILE_HEIGHT;
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

      // Symbols inside this file — packed top-to-bottom. If more symbols
      // exist than fit, they still get laid out (going past the file
      // bottom); tier-2 clipping/overflow is a future refinement.
      const symbols = symbolsByFile.get(file.relativePath) ?? [];
      let symY = fileY + FILE_HEIGHT - SYMBOL_TOP_INSET - SYMBOL_HEIGHT;
      for (const sym of symbols) {
        const id = `${file.relativePath}::${sym.name}`;
        const symNode: NodeState = {
          id,
          path: file.absolutePath,
          name: sym.name,
          kind: "symbol",
          symbol_kind: sym.kind,
          depth: 2,
          exports: [],
          imports: [],
          line_count: 0,
          byte_size: 0,
          x: fileNode.x + SYMBOL_INSET_X,
          y: symY,
          width: FILE_WIDTH - SYMBOL_INSET_X * 2,
          height: SYMBOL_HEIGHT,
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
          parent: file.relativePath,
        };
        if (sym.signature !== undefined) symNode.signature = sym.signature;
        out.push(symNode);
        symY -= SYMBOL_HEIGHT + SYMBOL_GAP;
      }

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
