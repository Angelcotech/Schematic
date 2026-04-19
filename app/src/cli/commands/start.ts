import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOrInitConfig } from "../../daemon/persist/config.js";
import { SCHEMATIC_HOME } from "../../daemon/persist/paths.js";
import { isDaemonRunning } from "../utils/daemon-client.js";

export interface StartOptions {
  openBrowser?: boolean;
}

export async function start(opts: StartOptions = {}): Promise<void> {
  const cfg = await readOrInitConfig();
  const url = `http://localhost:${cfg.port}/`;
  const shouldOpen = opts.openBrowser !== false;

  if (await isDaemonRunning()) {
    console.log(`↺ daemon already running on port ${cfg.port}`);
    if (shouldOpen) openUrl(url);
    return;
  }

  // Locate the daemon bin next to this CLI file. Both live under app/dist
  // (this file ends up at app/dist/cli/commands/start.js, and the daemon at
  // app/dist/daemon/bin.js — so two `..` from here).
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonBin = join(here, "..", "..", "daemon", "bin.js");

  // Redirect daemon stdout/stderr to a log file we can tail on startup
  // failure. Without this, EADDRINUSE and any other crash goes to
  // /dev/null and the user sees a bare "failed to start" message with no
  // explanation.
  await mkdir(SCHEMATIC_HOME, { recursive: true });
  const logPath = join(SCHEMATIC_HOME, "daemon.log");
  const logFd = openSync(logPath, "a");

  const child = spawn(process.execPath, [daemonBin], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  // Poll /status until the daemon is ready — hardwired timeout, no silent
  // retry loop.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) {
      console.log(`✔ daemon started at ${url}`);
      if (shouldOpen) openUrl(url);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Startup timed out. Read the last few lines of the log so the user
  // sees the actual reason (typically EADDRINUSE on the configured port).
  const tail = readLogTail(logPath, 20);
  const hint = tail.includes("EADDRINUSE")
    ? `\n\nPort ${cfg.port} is already in use. Override it with:\n  schematic config set port <N>\n  schematic install`
    : "";
  throw new Error(
    `[schematic] daemon failed to start within 5 seconds.${hint}\n\nLast lines from ${logPath}:\n${tail || "(log is empty)"}`,
  );
}

// Reads the last N lines of a log file. Keeps the error message focused
// on recent output instead of dumping the entire history.
function readLogTail(path: string, lineCount: number): string {
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    return lines.slice(-lineCount).join("\n");
  } catch {
    return "";
  }
}

// Cross-platform "open this URL in the user's default browser". Detaches
// so the CLI command can exit cleanly. Failures are silent — if the open
// command isn't available the daemon is still running and the user can
// copy the URL from stdout.
function openUrl(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const args = platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: platform === "win32" });
    child.unref();
  } catch {
    /* browser-open is best-effort */
  }
}
