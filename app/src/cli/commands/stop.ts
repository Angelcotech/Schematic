import { isDaemonRunning, shutdownDaemon } from "../utils/daemon-client.js";

export async function stop(): Promise<void> {
  if (!(await isDaemonRunning())) {
    console.log("↺ daemon not running");
    return;
  }
  await shutdownDaemon();
  // Give the daemon up to 2 seconds to actually exit. No retry loop —
  // single deterministic deadline.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!(await isDaemonRunning())) {
      console.log("✔ daemon stopped");
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("[schematic] daemon did not shut down cleanly");
}
