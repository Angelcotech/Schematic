// Direct daemon entry for pre-CLI Stage 3 testing. Once the `schematic`
// CLI lands in Stage 4, `schematic start` will wrap this.

import { startDaemon } from "./index.js";

const handle = await startDaemon();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[schematic] received ${signal}`);
  await handle.stop();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
