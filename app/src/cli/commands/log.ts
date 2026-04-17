// `schematic log --tail` streams live events from the daemon's WebSocket.
// Non-tail invocations print a short hint — persistent event-log files are
// deferred to a later stage (Stage 10 or 12 per BUILDSTEP).

import { WebSocket } from "ws";
import { readOrInitConfig } from "../../daemon/persist/config.js";
import type { WSServerMessage } from "../../shared/ws-messages.js";

export async function log(opts: { tail?: boolean; workspace?: string }): Promise<void> {
  if (!opts.tail) {
    console.log("schematic log --tail   (stream events live)");
    console.log("(persistent event-log files are not yet implemented)");
    return;
  }

  const cfg = await readOrInitConfig();
  const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws`);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "subscribe", workspace_id: opts.workspace }));
    const filter = opts.workspace ? ` (workspace=${opts.workspace})` : "";
    console.error(`[schematic] tailing events${filter}. Ctrl-C to stop.`);
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as WSServerMessage;
    if (msg.type === "ready") return;
    if (msg.type === "event") {
      const t = new Date(msg.event.timestamp).toISOString();
      process.stdout.write(`${t}  ${msg.event.type}  ${JSON.stringify(msg.event)}\n`);
    }
  });

  ws.on("close", () => process.exit(0));
  ws.on("error", (e) => {
    console.error("[schematic] ws error:", e.message);
    process.exit(1);
  });
}
