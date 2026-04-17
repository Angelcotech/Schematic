// Safely edits ~/.claude/settings.json. Preserves existing user entries and
// marks Schematic-owned entries so uninstall/reinstall can target them
// precisely. Fails loud if the file exists but contains invalid JSON —
// refuses to overwrite user content the parser can't interpret.

import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { atomicWrite } from "../../daemon/persist/atomic-write.js";

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const SCHEMATIC_ID = "schematic";

type HookMatcher = {
  matcher: string;
  hooks: Array<{
    type: "command" | "http" | "prompt" | "agent";
    command?: string;
    url?: string;
    timeout?: number;
    // Custom field we attach to identify Schematic-owned entries.
    _schematic?: typeof SCHEMATIC_ID;
  }>;
};

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  [k: string]: unknown;
}

async function readSettings(): Promise<ClaudeSettings> {
  try {
    const raw = await readFile(CLAUDE_SETTINGS, "utf8");
    try {
      return JSON.parse(raw) as ClaudeSettings;
    } catch {
      throw new Error(`[schematic] ${CLAUDE_SETTINGS} exists but is not valid JSON — refusing to overwrite`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

async function writeSettings(settings: ClaudeSettings): Promise<void> {
  await mkdir(dirname(CLAUDE_SETTINGS), { recursive: true });
  // Trailing newline matches common editor/linter expectations.
  await atomicWrite(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

function stripSchematic(settings: ClaudeSettings): ClaudeSettings {
  // Remove hook entries whose inner hooks are all Schematic-owned; also prune
  // any individual Schematic hook from mixed matchers.
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[event];
      const pruned: HookMatcher[] = [];
      for (const m of matchers) {
        const remaining = m.hooks.filter((h) => h._schematic !== SCHEMATIC_ID);
        if (remaining.length > 0) pruned.push({ ...m, hooks: remaining });
      }
      if (pruned.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = pruned;
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  if (settings.mcpServers?.[SCHEMATIC_ID]) {
    delete settings.mcpServers[SCHEMATIC_ID];
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  }
  return settings;
}

export interface InstallPaths {
  hookScriptPath: string; // absolute path to the Node hook script
}

export async function installSchematicEntries(paths: InstallPaths): Promise<void> {
  const settings = stripSchematic(await readSettings());

  settings.hooks ??= {};
  for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"] as const) {
    const existing = settings.hooks[event] ?? [];
    existing.push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `node ${paths.hookScriptPath}`,
          timeout: 10,
          _schematic: SCHEMATIC_ID,
        },
      ],
    });
    settings.hooks[event] = existing;
  }

  // MCP entry is a placeholder in Stage 4. Stage 10 replaces the command
  // with the real MCP child process.
  settings.mcpServers ??= {};
  settings.mcpServers[SCHEMATIC_ID] = {
    command: "echo",
    args: ["schematic MCP server — not wired until Stage 10"],
  };

  await writeSettings(settings);
}

export async function uninstallSchematicEntries(): Promise<void> {
  const settings = stripSchematic(await readSettings());
  await writeSettings(settings);
}

export { CLAUDE_SETTINGS };
