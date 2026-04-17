// Parses `tsc --noEmit --watch --pretty false` output.
//
// tsc's watch mode emits a sequence like:
//   12:34:56 - Starting compilation in watch mode...
//   path/to/file.ts(10,5): error TS2322: Type 'string' is not assignable to 'number'.
//   path/to/file.ts(22,9): error TS2345: Argument of type ...
//   12:34:59 - Found 2 errors. Watching for file changes.
//
// The "Found N errors" (or "Found 0 errors") banner marks the end of a
// compilation pass. We accumulate diagnostic lines and commit the full
// set to the caller on that banner — so the daemon always has a clean
// "current state" view, not a partial mid-compile view.

import { resolve } from "node:path";
import type { Diagnostic } from "../../../shared/diagnostic.js";

const DIAG_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/;
const DONE_BANNER = /Found \d+ error/;

export interface TscParserState {
  buffer: string;
  pending: Diagnostic[];
}

export function createTscParserState(): TscParserState {
  return { buffer: "", pending: [] };
}

// Consumes a chunk of stdout. Returns a fully-formed Diagnostic[] snapshot
// each time tsc finishes a compilation pass; returns null otherwise (more
// data expected before commit).
export function consumeTscChunk(
  state: TscParserState,
  cwd: string,
  chunk: string,
): Diagnostic[] | null {
  state.buffer += chunk;
  let committedSnapshot: Diagnostic[] | null = null;

  let newlineIdx: number;
  while ((newlineIdx = state.buffer.indexOf("\n")) !== -1) {
    const line = state.buffer.slice(0, newlineIdx).trimEnd();
    state.buffer = state.buffer.slice(newlineIdx + 1);
    const parsed = parseTscLine(cwd, line);
    if (parsed) {
      state.pending.push(parsed);
    } else if (DONE_BANNER.test(line)) {
      committedSnapshot = state.pending;
      state.pending = [];
    }
  }

  return committedSnapshot;
}

function parseTscLine(cwd: string, line: string): Diagnostic | null {
  const m = DIAG_LINE.exec(line);
  if (!m) return null;
  const [, filePath, lineStr, colStr, sev, code, message] = m;
  // tsc emits workspace-relative paths; resolve against the cwd it was
  // spawned in so the daemon can normalize to node IDs later.
  const absolute = resolve(cwd, filePath);
  const diag: Diagnostic = {
    file: absolute,
    line: Number(lineStr),
    column: Number(colStr),
    severity: sev === "warning" ? "warning" : "error",
    code,
    message: message.trim(),
    source: "tsc",
  };
  return diag;
}
