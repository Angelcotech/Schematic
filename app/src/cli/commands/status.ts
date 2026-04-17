import { isDaemonRunning, getStatus } from "../utils/daemon-client.js";

export async function status(): Promise<void> {
  if (!(await isDaemonRunning())) {
    console.log("daemon: not running");
    return;
  }
  const s = await getStatus();
  const mins = Math.floor(s.uptime_ms / 60000);
  const secs = Math.floor((s.uptime_ms % 60000) / 1000);
  console.log("daemon: running");
  console.log(`  uptime:     ${mins}m ${secs}s`);
  console.log(`  workspaces: ${s.workspaces}`);
  console.log(`  events:     ${s.events_processed}`);
  console.log(`  ws clients: ${s.ws_clients}`);
}
