# Schematic

Ask Claude Code to draw live architecture diagrams of your repo.

Schematic turns Claude Code into a draftsman. You tell it what to map — "diagram the WebGL pipeline," "extract the G1 engine," "how does auth connect to the API layer" — and Claude authors a canvas for you in your browser. Nodes are files, edges are labeled relationships, processes group related pieces. When Claude reads or edits a file, the matching node glows. When you click around in the browser, Claude-ready prompts land on your clipboard.

## Install

```
npm install -g claude-schematic
schematic install
```

That writes three Claude Code hooks to `~/.claude/settings.json`, registers an MCP server via `claude mcp add`, pre-authorizes the Schematic MCP tool namespace so you don't get prompted on every node/edge call, starts the daemon on `localhost:7777`, and opens the dashboard in your browser. If port 7777 is busy, it auto-picks the next free port up to 7800.

After install, **start a new Claude Code session** — hooks and MCP registrations only load at session start.

## Use

Open a Claude Code session and talk to it normally. Try:

- **"Open GateStack in Schematic."** — Claude calls `open_workspace`, registers your repo, and flips the browser to it.
- **"Diagram the WebGL pipeline."** — Claude reads the code, creates a canvas, places nodes, labels edges, arranges by data flow.
- **"Before I change `app/src/daemon/http.ts`, trace its impact."** — Claude calls `trace_impact`, reports every canvas that touches that file and what connects to it.

In the browser, **right-click** anything:

- **Right-click a file node** → copy "Blast radius," "Explain this file," or "Create canvas centered on this file" prompts.
- **Right-click a process container** → copy "Audit this group" or "Extract this process to its own canvas."
- **Right-click empty canvas** → copy "Audit canvas / Find hubs / Find orphans / Find cycles" prompts.

Every right-click action runs the query, packs the result into a Claude-ready prompt, and copies it to your clipboard. Paste into Claude and hit send.

> **Tip:** visit `localhost:7777/?welcome` to see the onboarding screen regardless of session state — useful for demos and screenshots.

## What Claude can do

Sixteen MCP tools ship in the box:

**Workspace management:** `open_workspace`, `list_workspaces`, `switch_view`, `pause_workspace`.

**Canvas authoring:** `create_canvas`, `bulk_populate`, `list_canvases`, `add_node`, `add_edge`, `move_node`, `move_process`, `auto_layout`, `delete_node`, `delete_edge`.

**Structural queries:** `trace_impact` (blast radius before refactors), `audit_canvas` (drift vs disk), `find_hubs` (high-degree keystones), `find_orphans` (zero-edge nodes), `find_cycles` (circular dependencies).

`bulk_populate` is the intended path for building a canvas from scratch — one call takes the whole node + edge set and lands the canvas atomically. Use `add_node` / `add_edge` only for incremental edits.

`auto_layout` runs a Sugiyama layered layout (via dagre) over the whole canvas in one call — respects process groupings, cleans up tangled diagrams. Use it after `bulk_populate` if the canvas reads messy, or whenever a hand-placed diagram has grown unreadable. `move_process` shifts a whole process group as a unit without touching individual nodes.

All five structural-query tools return JSON, so Claude can reason over the shape instead of parsing prose.

## CLI

```
schematic install            # wire hooks + MCP, start daemon
schematic start              # start daemon (no-op if running)
schematic stop               # graceful shutdown
schematic status             # uptime, workspace count, event count
schematic uninstall          # remove hooks + MCP, stop daemon
schematic config get port    # show daemon port
schematic config set port N  # change port (takes effect on next daemon start)
```

## Requirements

Node 20+. macOS, Linux, or Windows. Claude Code installed and working.

## License

MIT · © 2026 Angelco · [angelco.tech](https://angelco.tech)
