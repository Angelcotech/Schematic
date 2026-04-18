# Schematic

Live architecture map companion for Claude Code. Click a file in the browser — Claude knows what you mean.

Schematic runs as a local daemon beside Claude Code. It watches your repo, renders an interactive WebGL graph of modules and files, and keeps Claude's view of the codebase in sync with yours. When you click a file, Claude's next tool call can read it. When Claude reads a file, the node lights up on your screen.

## Install

```
npm install -g schematic
schematic install
```

`install` wires three Claude Code hooks and an MCP entry into `~/.claude/settings.json`, starts the daemon on `localhost:7777`, and opens the dashboard in your browser.

## Use

Work in Claude Code normally. In any repo with a `.schematic.json` at the root, Schematic auto-activates: file edits appear on the map in real time; clicking a node tells Claude what you're looking at.

```
schematic activate .        # opt-in to the current repo
schematic status            # daemon health
schematic stop              # shut down
schematic uninstall         # remove hooks + MCP entry
```

## Configure a repo

Add `.schematic.json` at the repo root:

```json
{
  "modules": {
    "app":      { "include": ["app/**"] },
    "frontend": { "include": ["frontend/**"] }
  },
  "health": {
    "sources": [
      { "kind": "tsc", "cwd": "app" }
    ]
  }
}
```

Modules become colored boxes; files become nodes inside them. Health sources (currently `tsc --watch`) drive red/green state on each file.

## Requirements

Node 20+. macOS, Linux, or Windows.

## License

MIT
