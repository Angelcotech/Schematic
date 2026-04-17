import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOrInitConfig } from "../../daemon/persist/config.js";
import { isDaemonRunning } from "../utils/daemon-client.js";

export async function start(): Promise<void> {
  const cfg = await readOrInitConfig();

  if (await isDaemonRunning()) {
    console.log(`↺ daemon already running on port ${cfg.port}`);
    return;
  }

  // Locate the daemon bin next to this CLI file. Both live under app/dist
  // (this file ends up at app/dist/cli/commands/start.js, and the daemon at
  // app/dist/daemon/bin.js — so three `..` from here).
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
      console.log(`✔ daemon started on port ${cfg.port}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error("[schematic] daemon failed to start within 5 seconds");
}
