import { writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMATIC_HOME } from "../../daemon/persist/paths.js";
import { readOrInitConfig } from "../../daemon/persist/config.js";
import { generateHookScript } from "../hook-template.js";
import { CLAUDE_SETTINGS, installSchematicEntries } from "../utils/settings-writer.js";
import { isDaemonRunning } from "../utils/daemon-client.js";
import { start as startCmd } from "./start.js";

export async function install(): Promise<void> {
  const cfg = await readOrInitConfig();
  const hooksDir = join(SCHEMATIC_HOME, "hooks");
  const hookScriptPath = join(hooksDir, "hook.mjs");

  console.log("Schematic installer");
  console.log("───────────────────");

  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookScriptPath, generateHookScript(cfg.port), "utf8");
  await chmod(hookScriptPath, 0o755);
  console.log(`✔ hook script written to ${hookScriptPath}`);

  await installSchematicEntries({ hookScriptPath });
  console.log(`✔ ${CLAUDE_SETTINGS} updated (MCP entry + 3 hooks)`);

  if (!(await isDaemonRunning())) {
    await startCmd();
  } else {
    console.log(`✔ daemon already running on port ${cfg.port}`);
  }

  console.log("");
  console.log("Schematic is ready.");
  console.log(`  Dashboard: http://localhost:${cfg.port}`);
  console.log(`  Stop:      schematic stop`);
  console.log(`  Uninstall: schematic uninstall`);
  console.log("");
  console.log("Open any Claude Code session and work normally.");
  console.log("Repos with .schematic.json or .schematic/ will auto-activate.");
}
