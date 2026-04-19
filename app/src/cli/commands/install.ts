import { writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

  // MCP server lives next to this compiled CLI — at app/dist/mcp/index.js.
  // Compute from import.meta.url so the path is correct wherever the
  // install binary is invoked from.
  const here = dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = resolve(here, "..", "..", "mcp", "index.js");

  console.log("Schematic installer");
  console.log("───────────────────");

  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookScriptPath, generateHookScript(), "utf8");
  await chmod(hookScriptPath, 0o755);
  console.log(`✔ hook script written to ${hookScriptPath}`);

  await installSchematicEntries({ hookScriptPath, mcpServerPath });
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
  console.log("Just talk to Claude Code. Try:");
  console.log('  "open ~/my-repo in schematic"');
  console.log('  "switch schematic to gatestack pro"');
  console.log('  "which files depend on app/src/daemon/http.ts?"');
  console.log("");
  console.log("Or use the CLI directly: schematic --help");
}
