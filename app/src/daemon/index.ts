import { createServer } from "node:http";
import { readOrInitConfig } from "./persist/config.js";
import { WorkspaceRegistry } from "./workspaces/registry.js";
import { WSBroadcaster } from "./ws.js";
import { createRequestHandler, type DaemonContext } from "./http.js";
import { NodeStoreRegistry } from "./node-store.js";
import { startDecayTick } from "./decay.js";
import { ActivationManager } from "./workspaces/activate.js";

export interface DaemonHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const config = await readOrInitConfig();

  const registry = new WorkspaceRegistry();
  await registry.load();

  const nodeStores = new NodeStoreRegistry();

  const httpServer = createServer();
  const ws = new WSBroadcaster(httpServer);

  const activations = new ActivationManager(nodeStores, ws);

  const ctx: DaemonContext = {
    registry,
    nodeStores,
    activations,
    ws,
    startedAt: Date.now(),
    state: { eventCount: 0 },
  };

  const stopDecay = startDecayTick(nodeStores, ws);

  // Background: activate any already-active workspaces from the persisted
  // registry. Uses the cache, so this is fast on restart.
  for (const ws of registry.all()) {
    if (ws.state === "active") {
      void activations.activate(ws).catch((e) =>
        console.error(`[schematic] startup activation failed for ${ws.name}:`, e),
      );
    }
  }

  // requestShutdown lets the POST /shutdown handler trigger graceful stop.
  // Populated below after `stop` is defined.
  let triggerShutdown: () => void = () => {};
  httpServer.on("request", createRequestHandler(ctx, () => triggerShutdown()));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, "127.0.0.1", () => resolve());
  });

  console.log(`[schematic] daemon listening on http://127.0.0.1:${config.port}`);
  console.log(`[schematic] ws://127.0.0.1:${config.port}/ws`);
  console.log(`[schematic] workspaces loaded: ${registry.all().length}`);

  const stop = async (): Promise<void> => {
    console.log("[schematic] shutdown: stopping decay tick");
    stopDecay();
    console.log("[schematic] shutdown: stopping fs watchers");
    await activations.shutdown();
    console.log("[schematic] shutdown: closing ws clients");
    ws.close();
    console.log("[schematic] shutdown: closing http server");
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    console.log("[schematic] shutdown: persisting registry");
    await registry.save();
    console.log("[schematic] stopped");
  };

  triggerShutdown = () => {
    void stop().then(() => process.exit(0));
  };

  return { port: config.port, stop };
}
