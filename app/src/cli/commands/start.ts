import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOrInitConfig } from "../../daemon/persist/config.js";
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

  const child = spawn(process.execPath, [daemonBin], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  // Poll /status until the daemon is ready — hardwired timeout, no silent retry loop.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) {
      console.log(`✔ daemon started at ${url}`);
      if (shouldOpen) openUrl(url);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error("[schematic] daemon failed to start within 5 seconds");
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

