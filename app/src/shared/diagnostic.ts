// A single diagnostic (error/warning) emitted by a health source.
// Paths are always absolute at this layer; the daemon normalizes to
// workspace-relative node IDs when mapping to NodeState.

export interface Diagnostic {
  file: string;        // absolute path
  line: number;        // 1-based
  column: number;      // 1-based
  severity: "error" | "warning" | "info";
  code?: string;       // e.g., "TS2322", "no-unused-vars"
  message: string;
  source: string;      // "tsc" | "eslint" | "pytest" | "mypy" | user-defined
}
