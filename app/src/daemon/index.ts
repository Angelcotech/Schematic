import { createServer } from "node:http";
import { readOrInitConfig } from "./persist/config.js";
import { WorkspaceRegistry } from "./workspaces/registry.js";
import { WSBroadcaster } from "./ws.js";
import { createRequestHandler, type DaemonContext } from "./http.js";

export interface DaemonHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const config = await readOrInitConfig();

  const registry = new WorkspaceRegistry();
  await registry.load();

  const httpServer = createServer();
  const ws = new WSBroadcaster(httpServer);

  const ctx: DaemonContext = {
    registry,
    ws,
    startedAt: Date.now(),
    state: { eventCount: 0 },
  };

  httpServer.on("request", createRequestHandler(ctx));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, "127.0.0.1", () => resolve());
  });

  console.log(`[schematic] daemon listening on http://127.0.0.1:${config.port}`);
  console.log(`[schematic] ws://127.0.0.1:${config.port}/ws`);
  console.log(`[schematic] workspaces loaded: ${registry.all().length}`);

  return {
    port: config.port,
    stop: async () => {
      console.log("[schematic] shutdown: closing ws clients");
      ws.close();
      console.log("[schematic] shutdown: closing http server");
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      console.log("[schematic] shutdown: persisting registry");
      await registry.save();
      console.log("[schematic] stopped");
    },
  };
}
