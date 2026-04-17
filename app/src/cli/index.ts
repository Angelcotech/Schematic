#!/usr/bin/env node
// `schematic` CLI entry. Hand-rolled dispatcher — no commander / yargs /
// argument-library dependency per Build Law 1 (hardwire).

import { install } from "./commands/install.js";
import { uninstall } from "./commands/uninstall.js";
import { start } from "./commands/start.js";
import { stop } from "./commands/stop.js";
import { status } from "./commands/status.js";
import { workspacesList, workspacesForget } from "./commands/workspaces.js";
import { activate, pause, resume, disable } from "./commands/state.js";
import { configGet, configSet } from "./commands/config.js";
import { log } from "./commands/log.js";

const USAGE = `schematic — live architecture map for Claude Code

USAGE:
  schematic <command> [args]

DAEMON:
  start              Start the daemon (no-op if already running)
  stop               Gracefully stop the daemon
  restart            Stop and start
  status             Print daemon status

INSTALL:
  install            Wire hooks + MCP into ~/.claude/settings.json; start daemon
  uninstall          Remove Schematic entries from ~/.claude/settings.json; stop daemon
                     [--purge also deletes ~/.schematic/]

WORKSPACES:
  workspaces list            List registered workspaces
  workspaces forget <id>     Remove a workspace from the registry
  activate [path]            Activate workspace at path (default: cwd)
  pause [path]               Pause workspace
  resume [path]              Resume paused workspace
  disable [path]             Disable workspace

CONFIG:
  config                     Print full config
  config get <key>           Print a config value
  config set <key> <value>   Set a config value

DEBUG:
  log --tail [--workspace <id>]   Stream events from the daemon
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return;
  }

  switch (cmd) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "restart":
      await stop();
      return start();
    case "status":
      return status();
    case "install":
      return install();
    case "uninstall":
      return uninstall({ purge: rest.includes("--purge") });
    case "workspaces": {
      const sub = rest[0];
      if (sub === "list") return workspacesList();
      if (sub === "forget") {
        const id = rest[1];
        if (!id) throw new Error("usage: schematic workspaces forget <id>");
        return workspacesForget(id);
      }
      throw new Error("usage: schematic workspaces [list|forget <id>]");
    }
    case "activate":
      return activate(rest[0] ?? process.cwd());
    case "pause":
      return pause(rest[0] ?? process.cwd());
    case "resume":
      return resume(rest[0] ?? process.cwd());
    case "disable":
      return disable(rest[0] ?? process.cwd());
    case "config": {
      const sub = rest[0];
      if (!sub) return configGet();
      if (sub === "get") return configGet(rest[1]);
      if (sub === "set") {
        const key = rest[1];
        const value = rest[2];
        if (!key || value === undefined) throw new Error("usage: schematic config set <key> <value>");
        return configSet(key, value);
      }
      throw new Error("usage: schematic config [get <key>|set <key> <value>]");
    }
    case "log":
      return log({
        tail: rest.includes("--tail"),
        workspace: argFollowing(rest, "--workspace"),
      });
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(USAGE);
      process.exit(2);
  }
}

function argFollowing(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
