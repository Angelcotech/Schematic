import { createServer } from "node:http";
import { readOrInitConfig } from "./persist/config.js";
import { WorkspaceRegistry } from "./workspaces/registry.js";
import { WSBroadcaster } from "./ws.js";
import { createRequestHandler, type DaemonContext } from "./http.js";
import { startDecayTick } from "./decay.js";
import { ActivationManager } from "./workspaces/activate.js";
import { CanvasStoreRegistry } from "./canvas/store.js";
import { FileActivityRegistry } from "./file-activity.js";

export interface DaemonHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const config = await readOrInitConfig();

  const registry = new WorkspaceRegistry();
  await registry.load();

  const canvasStores = new CanvasStoreRegistry();
  const fileActivity = new FileActivityRegistry();

  const httpServer = createServer();
  const ws = new WSBroadcaster(httpServer);

  const activations = new ActivationManager(fileActivity, ws);

  const persistedFocus = config.focused_workspace_id
    ? registry.get(config.focused_workspace_id)
    : null;
  const firstActive = registry.all().find((w) => w.state === "active") ?? null;
  const initialFocus = persistedFocus ?? firstActive ?? null;

  const ctx: DaemonContext = {
    registry,
    canvasStores,
    fileActivity,
    activations,
    ws,
    startedAt: Date.now(),
    state: { eventCount: 0, focusedWorkspaceId: initialFocus?.id ?? null },
  };

  const stopDecay = startDecayTick(fileActivity, ws);

  // Background: start health runners for already-active workspaces.
  // No extraction — CC authors canvases, the watcher is irrelevant.
  for (const workspace of registry.all()) {
    if (workspace.state === "active") {
      void activations.activate(workspace).catch((e) =>
        console.error(`[schematic] startup activation failed for ${workspace.name}:`, e),
      );
    }
  }

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
    console.log("[schematic] shutdown: stopping health runners");
    activations.shutdown();
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
