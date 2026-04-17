import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMATIC_HOME } from "../../daemon/persist/paths.js";
import { uninstallSchematicEntries, CLAUDE_SETTINGS } from "../utils/settings-writer.js";
import { isDaemonRunning, shutdownDaemon } from "../utils/daemon-client.js";

export async function uninstall(opts: { purge?: boolean } = {}): Promise<void> {
  console.log("Schematic uninstaller");
  console.log("─────────────────────");

  await uninstallSchematicEntries();
  console.log(`✔ removed Schematic entries from ${CLAUDE_SETTINGS}`);

  if (await isDaemonRunning()) {
    await shutdownDaemon();
    console.log(`✔ daemon stopped`);
  }

  await rm(join(SCHEMATIC_HOME, "hooks"), { recursive: true, force: true });
  console.log(`✔ removed hook scripts`);

  if (opts.purge) {
    await rm(SCHEMATIC_HOME, { recursive: true, force: true });
    console.log(`✔ purged ${SCHEMATIC_HOME} (layouts, cache, config)`);
  } else {
    console.log(`↺ kept ${SCHEMATIC_HOME} (workspaces.json, config.json). Use --purge to delete.`);
  }
}
