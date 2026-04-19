// Safely edits ~/.claude/settings.json. Preserves existing user entries and
// marks Schematic-owned entries so uninstall/reinstall can target them
// precisely. Fails loud if the file exists but contains invalid JSON —
// refuses to overwrite user content the parser can't interpret.
//
// MCP servers are a separate story: Claude Code reads MCP registrations
// from its own internal store (~/.claude.json), NOT from settings.json.
// We shell out to `claude mcp add` so the registration lands in the file
// CC actually reads. settings.json.mcpServers was ignored in practice —
// that's why users saw "tools not in deferred list" on fresh installs.

import { exec } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { atomicWrite } from "../../daemon/persist/atomic-write.js";

// Shell-based exec, not execFile. execFile against `claude` (a Bun-compiled
// Mach-O binary on macOS) intermittently fails with ENOEXEC or ENOENT when
// called from this CLI subprocess — the parent shell handles the binary
// fine, but Node's direct exec path doesn't. Routing through `sh -c` lets
// the shell resolve PATH and handle binary exec the same way the user's
// interactive shell does.
const execAsync = promisify(exec);

// Escape a single arg for safe inclusion in a `sh -c` command line. Wraps
// the value in single quotes and escapes any embedded single quotes.
function shEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

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
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  [k: string]: unknown;
}

// Pattern that allows every Schematic MCP tool without prompting. Canvas
// authoring needs 30+ tool calls per diagram — manual approval for each
// would make the tool unusable. Users still see tool-use UI in CC, just
// without the "allow/deny" modal per call.
const SCHEMATIC_PERMISSION = "mcp__schematic__*";

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
  if (settings.permissions?.allow) {
    settings.permissions.allow = settings.permissions.allow.filter(
      (p) => p !== SCHEMATIC_PERMISSION,
    );
    if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
    if (
      !settings.permissions.allow &&
      !settings.permissions.deny?.length &&
      !settings.permissions.ask?.length
    ) {
      delete settings.permissions;
    }
  }
  return settings;
}

export interface InstallPaths {
  hookScriptPath: string; // absolute path to the Node hook script
  mcpServerPath: string;  // absolute path to the compiled MCP server entry
}

export interface InstallResult {
  // Non-fatal diagnostics — printed by the CLI after install completes.
  warnings: string[];
}

export async function installSchematicEntries(paths: InstallPaths): Promise<InstallResult> {
  const warnings: string[] = [];

  // --- Hooks: live in settings.json. CC reads them correctly from here. ---
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

  // --- Permissions: pre-approve the Schematic MCP tool namespace so CC
  // doesn't modal-prompt on every add_node / add_edge call. A single
  // canvas needs 30+ tool calls; approval fatigue would kill the UX.
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  if (!settings.permissions.allow.includes(SCHEMATIC_PERMISSION)) {
    settings.permissions.allow.push(SCHEMATIC_PERMISSION);
  }

  await writeSettings(settings);

  // --- MCP: register via the Claude Code CLI. ---
  // `claude mcp add -s user -- node <path>` lands the registration in
  // CC's internal store (~/.claude.json). Writing to settings.json
  // doesn't work in practice — CC ignores that field for MCP.
  try {
    const execOpts = { env: process.env };
    const serverPath = shEscape(paths.mcpServerPath);
    // `remove` is idempotent-ish: fails if not present, so swallow.
    await execAsync(`claude mcp remove -s user ${SCHEMATIC_ID}`, execOpts).catch(() => {});
    await execAsync(`claude mcp add -s user ${SCHEMATIC_ID} node ${serverPath}`, execOpts);
  } catch (e) {
    // Most common cause: `claude` CLI not on PATH, or CC version without
    // the mcp subcommand. Tell the user how to finish manually rather
    // than failing the whole install.
    warnings.push(
      `Could not register MCP server via the Claude Code CLI.\n` +
      `  Reason: ${(e as Error).message}\n` +
      `  To finish by hand:\n` +
      `      claude mcp add -s user ${SCHEMATIC_ID} node ${paths.mcpServerPath}`,
    );
  }

  return { warnings };
}

export async function uninstallSchematicEntries(): Promise<void> {
  // Remove hooks from settings.json.
  const settings = stripSchematic(await readSettings());
  await writeSettings(settings);
  // Remove MCP registration from CC's store. Swallow errors — the entry
  // may not be present (uninstall from a partial install) or the CLI
  // may be unavailable; neither should block cleanup.
  await execAsync(
    `claude mcp remove -s user ${SCHEMATIC_ID}`,
    { env: process.env },
  ).catch(() => {});
}

export { CLAUDE_SETTINGS };
