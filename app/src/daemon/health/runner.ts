// Generic watch-mode runner for a single health source.
//
// A source is a shell command the daemon spawns and keeps running. Its
// stdout is streamed through a named parser; each compilation pass yields
// a snapshot Diagnostic[] that replaces the prior set. If the underlying
// process crashes, the runner restarts it with exponential backoff — up
// to MAX_BACKOFF_MS between attempts.
//
// Stop() is deterministic: calls kill + waits. No silent swallow.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { Diagnostic } from "../../shared/diagnostic.js";
import { consumeTscChunk, createTscParserState } from "./parsers/tsc.js";

// Resolve the bundled tsc once at module load. The daemon has `typescript`
// as a runtime dep (installed in Stage 6 for AST parsing), so this path
// is guaranteed regardless of what the target workspace has in its own
// node_modules.
const require = createRequire(import.meta.url);
const TSC_BIN = require.resolve("typescript/bin/tsc");

export interface HealthSourceConfigBase {
  /** Human-readable name for logs. */
  name: string;
  /** Absolute cwd the command runs in. */
  cwd: string;
}

export type HealthSourceConfig =
  | (HealthSourceConfigBase & {
      type: "tsc";
      /** Relative path to tsconfig.json from cwd, or undefined for default. */
      project?: string;
    })
  | (HealthSourceConfigBase & {
      type: "command";
      /** Shell command (passed via `sh -c`). Must run in watch/long-running mode. */
      run: string;
      /** Parser name — for v1, only "tsc" is implemented. */
      parser: "tsc";
    });

const RESTART_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
const MAX_BACKOFF_MS = 60_000;

export class HealthSourceRunner {
  private child: ChildProcess | null = null;
  private stopped = false;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: HealthSourceConfig,
    private readonly onSnapshot: (diagnostics: Diagnostic[]) => void,
  ) {}

  start(): void {
    if (this.stopped) return;
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.child = null;
    // Detach our listeners so the dying child doesn't retrigger our
    // restart logic. Don't `.destroy()` the stdio streams — that corrupts
    // the pipe FDs Node reuses for the next spawn (observed as EBADF on
    // a subsequent spawn). Don't `.unref()` either; Node handles child
    // cleanup fine once SIGTERM lands.
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    // Fallback SIGKILL after 3s in case the child ignored SIGTERM.
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, 3_000).unref();
  }

  private spawnChild(): void {
    const { cmd, args, parserState } = this.resolveCommand();
    const child = spawn(cmd, args, {
      cwd: this.config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    this.child = child;
    this.restartAttempt = 0;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      const snapshot = consumeTscChunk(parserState, this.config.cwd, chunk);
      if (snapshot !== null) this.onSnapshot(snapshot);
    });

    child.stderr?.on("data", (chunk: string) => {
      // Log non-diagnostic stderr only if it looks like an error. `tsc`
      // prints compilation noise on stderr occasionally.
      const trimmed = chunk.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("Warning:")) {
        console.warn(`[schematic:health:${this.config.name}] stderr: ${trimmed}`);
      }
    });

    child.on("exit", (code, signal) => {
      if (this.stopped) return;
      console.warn(
        `[schematic:health:${this.config.name}] exited (code=${code}, signal=${signal}), restarting`,
      );
      this.scheduleRestart();
    });

    child.on("error", (err) => {
      if (this.stopped) return;
      console.warn(`[schematic:health:${this.config.name}] spawn error:`, err.message);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    const delay =
      RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)] ??
      MAX_BACKOFF_MS;
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnChild();
    }, delay);
  }

  private resolveCommand(): {
    cmd: string;
    args: string[];
    parserState: ReturnType<typeof createTscParserState>;
  } {
    if (this.config.type === "tsc") {
      const projectArgs = this.config.project ? ["-p", this.config.project] : [];
      // Run tsc via `node <path-to-tsc>` so we don't depend on whatever is
      // or isn't in the target workspace's node_modules/.bin. The daemon
      // itself has typescript as a runtime dep.
      //
      // `--pretty false` ensures plain `file(line,col): error TSxxxx: msg`
      // lines which the parser matches. `--preserveWatchOutput` stops tsc
      // from clearing its prior output between passes.
      return {
        cmd: process.execPath,
        args: [TSC_BIN, "--noEmit", "--watch", "--pretty", "false", "--preserveWatchOutput", ...projectArgs],
        parserState: createTscParserState(),
      };
    }
    // type === "command" — v1 supports only the tsc parser for generic
    // commands; other parsers are stubs that throw.
    if (this.config.parser !== "tsc") {
      throw new Error(
        `[schematic] parser '${this.config.parser}' is not implemented in v1. Only 'tsc' is supported.`,
      );
    }
    return {
      cmd: "sh",
      args: ["-c", this.config.run],
      parserState: createTscParserState(),
    };
  }
}
