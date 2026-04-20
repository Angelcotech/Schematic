import { writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SCHEMATIC_HOME } from "../../daemon/persist/paths.js";
import { readOrInitConfig } from "../../daemon/persist/config.js";
import { generateHookScript } from "../hook-template.js";
import { installSchematicEntries } from "../utils/settings-writer.js";
import { isDaemonRunning } from "../utils/daemon-client.js";
import { start as startCmd } from "./start.js";

// Open a URL in the user's default browser without blocking install on
// the subprocess. Platform-appropriate command: macOS uses `open`, Linux
// uses `xdg-open`, Windows uses `start` (via cmd.exe). Detached + unref
// so the install process exits cleanly even if the browser takes a
// second to launch. Silent on failure — never blocks install completion.
function openInBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open"; args = [url];
  } else if (platform === "win32") {
    cmd = "cmd"; args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open"; args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => { /* browser missing or blocked — silent */ });
    child.unref();
  } catch { /* silent */ }
}

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

  const installResult = await installSchematicEntries({ hookScriptPath, mcpServerPath });
  console.log(`✔ Claude Code wired up — 3 hooks + MCP server registered`);
  for (const warning of installResult.warnings) {
    console.log("");
    console.log(`⚠ ${warning}`);
  }

  if (!(await isDaemonRunning())) {
    await startCmd();
  } else {
    console.log(`✔ daemon already running on port ${cfg.port}`);
  }

  const dashboardUrl = `http://localhost:${cfg.port}`;

  console.log("");
  console.log("Schematic is ready.");
  console.log(`  Dashboard: ${dashboardUrl}`);
  console.log(`  Stop:      schematic stop`);
  console.log(`  Uninstall: schematic uninstall`);
  console.log("");
  console.log("Just talk to Claude Code. Try:");
  console.log('  "open ~/my-repo in schematic"');
  console.log('  "switch schematic to gatestack pro"');
  console.log('  "which files depend on app/src/daemon/http.ts?"');
  console.log("");
  console.log("Or use the CLI directly: schematic --help");

  // Auto-open the dashboard. First-time users see the welcome + mockup
  // immediately (no focused workspace → welcome renders); returning
  // users land on their last-focused canvas (recency sort). Same URL
  // handles both — no need to force ?welcome.
  openInBrowser(dashboardUrl);
}
