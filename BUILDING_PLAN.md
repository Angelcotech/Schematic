# Schematic — Building Plan

Living planning document. Captures decisions as they are made. No code yet.

---

## Contents

1. [Product](#1-product)
2. [Core Interaction Model](#2-core-interaction-model)
3. [Node State Schema](#3-node-state-schema)
4. [Multi-Tier Zoom](#4-multi-tier-zoom)
5. [Manual Layout & Drag](#5-manual-layout--drag)
6. [Integration Architecture](#6-integration-architecture)
7. [Workspace Model & Daemon](#7-workspace-model--daemon)
8. [Health Integration](#8-health-integration)
9. [Deployment](#9-deployment)
10. [Tech Stack](#10-tech-stack)
11. [Relationship to GateStack Pro](#11-relationship-to-gatestack-pro)
12. [Open Questions](#12-open-questions)
13. [Build Phases](#13-build-phases)
14. [Design Invariants](#14-design-invariants)
15. [History](#15-history)

---

## 1. Product

**Schematic** is an interactive architecture map. It renders the codebase as a node graph that the developer and an AI assistant (Claude Code) both operate on in real time.

**The gap it closes:** the developer carries the architecture mentally; the AI operates on file paths. The user is effectively blind when directing edits across a large codebase. Schematic is a window that closes that gap — both parties highlight, click, and navigate the same graph.

**What it is not:** not a codebase visualizer, not a documentation tool, not a static diagram renderer. Schematic is a *collaboration primitive* — its value is in the bidirectional real-time shared context between human and AI.

**Audience:** developers who work with AI assistants (primarily Claude Code) on non-trivial codebases.

---

## 2. Core Interaction Model

- **Nodes** = modules, files, and symbols (functions/classes/types)
- **Edges** = import/dependency and call relationships
- **Continuous zoom** — one infinite graph. Camera flies from architectural overview down to individual symbols. No discrete views, no "back button."
- **Bidirectional highlighting** — both developer and Claude Code can mark, select, and focus nodes. State broadcasts to all clients in real time.
- **Manual layout** — users drag modules/files to encode their own mental architecture. Manual positions are sacred; auto-layout never overwrites them.
- **Activity propagation** — when CC edits something deep in the tree, parent modules glow dimmer versions of the same state, so activity is visible at every zoom level.

---

## 3. Node State Schema

The schema is **multi-dimensional**. A node can simultaneously be user-selected, being edited by CC, in the current prompt context, recently modified, and failing type-check. These are orthogonal dimensions, never collapsed into a single status.

```ts
interface NodeState {
  // Identity (immutable)
  id: string;                     // stable — repo-relative path (or path + symbol name for symbols)
  path: string;                   // absolute file path
  name: string;                   // display basename
  kind: "file" | "directory" | "module" | "group" | "external" | "symbol" | "visual_group";
  language?: string;              // "ts", "tsx", "py", etc.
  symbol_kind?: "function" | "class" | "interface" | "type" | "constant" | "method";
  signature?: string;             // e.g., "extractFeatures(bars: Bar[]): Features"

  // Hierarchy (tree over the flat graph)
  parent?: string;                // parent node ID
  children?: string[];            // child node IDs (for modules/files)
  depth: number;                  // 0 = top-level module

  // Structure (re-derived on file change)
  exports: string[];
  imports: string[];              // outgoing edge targets
  line_count: number;
  byte_size: number;

  // Layout (persisted)
  x: number; y: number;
  width: number; height: number;
  manually_positioned: boolean;   // user dragged — auto-layout must skip
  manually_sized: boolean;        // user resized bounds — auto-fit disabled
  layout_locked: boolean;         // optional: prevent accidental drags

  // AI intent (ephemeral)
  ai_intent: "idle" | "planning" | "editing" | "modified" | "deleted" | "failed";
  ai_intent_since?: number;
  ai_intent_tool?: string;        // "Edit" | "Write" | "Bash rm" | ...

  // User interaction (ephemeral)
  user_state: "none" | "hovered" | "selected" | "pinned";
  user_multi_selected: boolean;

  // Focus (ephemeral)
  in_arch_context: boolean;       // currently injected into CC prompts
  last_mention_ts?: number;       // timestamp of most recent mention in conversation
  last_mention_source?: "user" | "ai";

  // Aggregated state (for parents — rolled up from descendants)
  aggregated_ai_intent: "idle" | "active";
  aggregated_activity_count: number;
  aggregated_activity_ts: number;
  aggregated_health: { ok: number; warning: number; error: number };

  // Health (derived, refreshed continuously)
  health: "ok" | "warning" | "error" | "unknown";
  health_detail?: string;
  health_source?: string;         // "tsc" | "eslint" | "pytest" | ...
  health_updated_ts?: number;

  // Timestamps
  last_ai_touch?: number;
  last_user_touch?: number;
  last_fs_change?: number;
}

interface Edge {
  source: string;
  target: string;
  kind: "import" | "dynamic_import" | "type_only" | "side_effect" | "calls" | "extends" | "implements";
  highlighted: boolean;
  weight?: number;                // for aggregated cross-module edges
}
```

**Visual encoding is composed from state, not stored.** The renderer reads the dimensions and decides: base fill from language, border from `user_state`, halo from `ai_intent`, brightness from time since `last_ai_touch`, dashed outline from `health`, subtle glow from `last_mention_ts` recency. Visual rules can change without schema churn.

**Decay is first-class.** `ai_intent = "modified"` auto-demotes to `"idle"` after ~5 minutes with fading brightness. `in_arch_context` flips off when CC's next prompt no longer includes the node. Mention glow fades continuously based on `now - last_mention_ts`. Without decay, the map becomes a christmas tree.

---

## 4. Multi-Tier Zoom

**One graph, four tiers of resolution.** LOD (level-of-detail) culling renders only what the current camera zoom warrants — a 10k-file repo stays fast because the top-level view renders ~20 module rectangles, not 10k files.

| Zoom | Resolution | Typical node count |
|------|-----------|-------------------|
| 0–10% | Modules only | 5–20 |
| 10–40% | Modules + files | 100–1000 |
| 40–80% | Files + symbols (exports) | 1k–10k |
| 80%+ | All symbols + internal call edges | full detail |

**Symbol extraction is lazy.** File-level parsing (imports) happens eagerly at graph-build time. Symbol-level parsing (functions, classes, call edges) runs on demand the first time a user zooms into a file, then caches.

**Cross-layer edges auto-aggregate.** At Level 0 (modules only), all underlying file-to-file imports between two modules collapse into **one thick edge** between the module nodes, with `weight = count`. Hover → tooltip lists the underlying connections. As the user zooms in, aggregated edges dissolve into individual ones.

**Activity propagates through the tree.** When CC edits `engine/parser.ts` → `extractFeatures()`:
1. Symbol node: `ai_intent = "modified"` (bright green glow)
2. File `parser.ts`: `aggregated_ai_intent = "active"` (dimmer glow)
3. Module `Engine`: `aggregated_ai_intent = "active"` (dimmer still)
4. Top-level view: subtle pulse on the Engine rectangle

Users see "something is happening inside Engine" at any zoom level.

### Module definition

**Default: auto-from-directory structure.** Every directory in the repo becomes a module. Zero-config — clone a repo and Schematic works immediately. `.gitignore` is always respected.

**Override: optional `.schematic.json` at repo root** for authorial control when directory structure doesn't match your mental architecture:

```json
{
  "modules": {
    "Engine": { "paths": ["src/engine/**", "src/core/pipeline/**"] },
    "Rendering": { "paths": ["src/renderer/**", "src/shaders/**"] }
  },
  "ignore": ["dist", "build"],
  "entrypoints": ["src/main.ts"]
}
```

TypeScript config (`.schematic.config.ts`) is deferred — not needed for v1.

---

## 5. Manual Layout & Drag

Auto-layout is a starting point. Dragging is how developers encode their own mental architecture into the map.

### Drag semantics per tier

- **Modules:** dragging moves the module and all descendants as a single unit, like moving a folder. A single shader transform applies to the whole subtree — one draw call regardless of children count.
- **Files within a module:** dragging repositions within the module's local coordinate space. The module's outer rectangle auto-grows/shrinks to fit children with padding.
- **Symbols within a file:** auto-laid only. Manual symbol positioning is diminishing returns.

### Collision: push-apart physics

When a dragged module would collide with neighbors, the neighbors push apart (force-directed physics). Overlap is never allowed at rest. During drag, the user sees neighbors smoothly displace; on drop, the layout settles.

### Module bounds

- **Auto-fit by default:** bounds recompute to wrap children with padding every time children move or are added/removed.
- **User-sized opt-in:** if the user grabs a module edge and resizes it, `manually_sized = true` and auto-fit disables for that module. The user now owns those bounds.

### Placement — incremental, always

Two distinct operations, never conflated:

**Incremental placement (automatic, continuous).** New node appears → placed near its nearest imported/importing neighbor within its module. Push-apart physics resolve any overlap. Manual positions are never touched. Scales to any batch size — 50 files appearing at once each slot in near their graph neighbors, push-apart keeps things clean. No threshold, no batching, no "layout event."

**Full re-layout (manual only, user-triggered).** Wipes all `manually_positioned` flags, runs force-directed from scratch. Single "Re-layout" action in the browser UI. **The only way any existing manual position is ever moved.** Invariant #6 is truly invariant.

### Multi-select and bulk drag

- **Lasso select:** shift-drag on empty canvas draws a rectangle; all nodes within are multi-selected.
- **Ctrl/Cmd-click:** adds/removes individual nodes from multi-selection.
- **Bulk drag:** dragging any multi-selected node moves all selected nodes together, preserving relative positions.

### Visual groups (deferred to v2)

A `visual_group` kind would let users lasso-select unrelated files and label them as a cluster ("payment flow") with no filesystem backing. **Deferred.** v1 ships without this.

### Layout drift (v1.5 / v2 candidate)

Incremental placement is locally good but globally drift-prone. Over many additions, the map can get cluttered. Two non-v1 candidates to address this:

- **Drift-metric notification (v1.5):** track a drift score (avg edge crossings, long-edge count) and toast "Layout has gotten cluttered — re-layout?" when it crosses threshold. Never auto-triggers.
- **Gentle background optimization (v2):** when the daemon is idle, run a low-intensity force simulation pass that nudges *non-manual* nodes toward locally better positions without snapping them.

### Broadcast cadence

- **During drag:** no intermediate broadcasts. Local render only.
- **On drag end:** one `user.node_moved(id, x, y, bounds?)` event broadcasts, server persists with ~500ms debounce.
- CC is **position-blind** by default — node positions don't appear in `arch_context`.

---

## 6. Integration Architecture

The load-bearing design principle: **Claude Code must not have to remember Schematic exists.** Every integration point is structural (harness, hooks, context injection) rather than behavioral (CC remembering to call a tool).

### Topology

```
Browser tab (WebGL view)  ←WebSocket→  Local server  ←MCP + hooks→  Claude Code
```

The **local server is the single source of truth.** Browser and CC are both clients. They never talk to each other directly.

### Three wiring layers

**1. Hooks — write-side, automatic**

- `PreToolUse(Edit|Write)` → node turns yellow (`ai_intent = "planning"`)
- `PostToolUse(Edit|Write)` success → node turns green (`ai_intent = "modified"`)
- `PostToolUse(Bash rm/mv)` → node turns red (`ai_intent = "deleted"`)
- CC does nothing. The harness fires the hook; a shell script POSTs to the server; the browser receives the WS update.

**2. MCP server — read-side, on-demand**

- `arch_neighbors(node)` — what imports/depends on this
- `arch_impact(node)` — blast radius of changing it
- `arch_find(query)` — fuzzy locate a component
- `arch_get_selection()` — currently selected node IDs
- `arch_health(node)` — diagnostics for the node (errors, warnings)
- Layer-aware: queries resolve at the granularity of the node ID passed (module vs. file vs. symbol).

**3. UserPromptSubmit hook — read-side, automatic context injection**

- Before every user prompt reaches CC, a hook queries the server for current selection
- Prepends `<arch-context>` to the prompt with current focus and diagnostics
- CC sees the user's spatial focus automatically, every turn, without being told

### Conversation mention extraction

Both sides of the conversation feed mentions into node state:

**User-side (UserPromptSubmit hook):** tokenize the incoming prompt, run a single-pass Aho-Corasick automaton over the node-name index (paths, basenames, module names, symbol names). Matches update `last_mention_ts` and `last_mention_source = "user"`.

**CC-side (PreToolUse hook):** every CC tool call that includes a path (Edit, Write, Read, Grep, Glob, Bash with file args) is a mention of that node. No text parsing needed — tool inputs are ground truth of what CC is working with.

Both run automatically. No CC cognition required. The Aho-Corasick index is built at graph-build time and updated incrementally when nodes are added/removed.

**Ambiguity handling:** exact basename → full weight. Partial match → lower weight. Multiple candidates → rank by recency (recent nodes win) and AI/user activity (already-focused nodes win), pick top N with reduced weight each.

### Why claude-in-chrome is NOT in this architecture

claude-in-chrome is for when CC has to *drive a browser like a user* (click, screenshot, read rendered pages). Wrong model here. CC does not need to *see* the map; it reads state as structured JSON via MCP. Deterministic, instant, no pixel coordinates, no flakiness.

### Eventual-consistency property

The server holds all state. CC can keep marking nodes yellow/green even when the browser tab is closed. When the tab reopens, WebSocket reconnects and renders the current state.

### Event stream

All state changes flow as events through the server:

```
node.select / node.deselect / node.hover
node.mentioned (source: "user" | "ai")
ai.edit_planned / ai.edit_succeeded / ai.edit_failed / ai.delete
context.node_added / context.node_removed
user.node_moved / user.multi_selected / user.node_resized
fs.modified / fs.deleted
health.updated
workspace.activated / workspace.paused / workspace.disabled
```

Server applies, computes state delta, broadcasts to all clients. Gives you a free undo log, replay for debugging, and an audit trail.

---

## 7. Workspace Model & Daemon

**One multi-tenant daemon** on a fixed port (`7777` by default). Single process manages state for all registered repos. Claude Code integration (MCP + hooks) is configured **once globally** and routes per call based on `cwd`.

### Workspace identity

- Workspace = (repo root path, git remote URL if present)
- Repo root discovery: walk up from `cwd` until `.git/`, `.schematic/`, or `.schematic.json` is found
- Persisted in `~/.schematic/workspaces.json` keyed by workspace ID (hash of root path)

### State machine

| State | Meaning | Hooks applied? | `<arch-context>` injected? |
|-------|---------|---------------|-----------------|
| `unknown` | Never seen this cwd | — | — |
| `registered` | Path seen, no processing | No | No |
| `active` | Full treatment: graph, health, state | Yes | Yes |
| `paused` | Was active, user paused | No | No (graph cache kept) |
| `disabled` | Opt-out marker present | No | No |

Transitions:
- `unknown → registered` — auto, on first hook call from a new cwd
- `registered → active` — auto if `.schematic.json` or `.schematic/` present; otherwise manual via UI or `schematic activate`
- `active → paused | disabled` — manual
- any → `disabled` — via `.schematic-ignore` or global config

### Activation paths

1. **Auto-activation — explicit intent marker.** `.schematic.json` or `.schematic/` present → activate on first touch. This is how a project commits "yes, use Schematic here" alongside the code.
2. **Manual activation — UI / CLI.** No marker → daemon registers silently on first hook. You visit `localhost:7777`, see it in the workspace list, click "Activate." Or run `schematic activate` in the repo.
3. **Implicit activation — browser URL.** Opening `localhost:7777/w/<id>` for a registered workspace activates it (matches user intent without a button click).

### Opt-out

- `.schematic-ignore` file in repo root → permanent `disabled`
- Global `~/.schematic/config.json` with ignored path patterns
- Either wins over any activation signal

### Persistence layout

```
~/.schematic/
  config.json              # global settings, ignored paths
  workspaces.json          # registry: id → { path, name, git_remote, state }
  workspaces/
    <id>/
      positions.json       # manual layout
      graph.json           # cached node/edge data
      events.log           # event stream
      health-cache.json    # last known diagnostics
      mention-index.bin    # serialized Aho-Corasick automaton
```

### Daemon lifecycle

- **Start:** auto on first MCP connection (CC triggers it); manual via `schematic start`
- **Run:** idles in background across CC sessions, low resource usage when all workspaces paused
- **Stop:** `schematic stop`; no auto-shutdown (once started, stays running until explicitly stopped or user logs out)
- **CLI:** `schematic start | stop | status | workspaces list | activate | pause | forget <id>`
- **Login auto-start:** optional LaunchAgent (macOS) or equivalent — phase-9 polish, not v1 required

### Initial extraction UX

Activation of a large repo may take a few seconds to index. The server:
- Responds immediately to the activation request
- Streams extraction progress via WebSocket
- Browser shows "Indexing 847 of 3200 files..." overlay
- Health sources start after initial extraction completes

No blocking; no timeouts that bite on big repos.

### Cross-repo edges (deferred to v2)

A workspace can declare "depends on workspace X" in config. Schematic renders edges that cross workspace boundaries. Useful when your project consumes another repo you're also working on (e.g., shared library + app). Not in v1.

---

## 8. Health Integration

**Properly scoped from v1.** Health is one of the most action-forcing overlays on the map — a red outline on "this file won't compile" drives behavior more directly than an AI-intent halo. We build the infrastructure properly, ship with one first-class source (`tsc --watch`) plus a generic runner that takes any tool.

### Architecture

```
External tools (tsc, eslint, mypy, ...)
        │
        ▼
HealthSource runners (per-tool processes, managed lifecycle)
        │
        ▼
Diagnostic stream → server
        │
        ▼
Path normalization → node ID mapping
        │
        ▼
Debounce + aggregate → node state update
        │
        ▼
Broadcast via WS + arch_health via MCP
```

### What ships in v1

**First-class source: `tsc --watch`.** TypeScript's daemon mode emits JSON diagnostics. Schematic launches and manages the tsc process, streams its output, maps diagnostics to file and symbol nodes. David's primary language — integration has to be first-class from day one.

**Generic command runner.** For any other tool, users declare a shell command plus an output parser in `.schematic.json`:

```json
{
  "health": {
    "sources": [
      { "type": "tsc", "project": "tsconfig.json" },
      { "type": "eslint", "config": ".eslintrc.js" },
      { "type": "command", "name": "pytest", "run": "pytest --json", "parser": "pytest-json" },
      { "type": "command", "name": "mypy",   "run": "dmypy run -- --json", "parser": "mypy-json" }
    ]
  }
}
```

v1 ships with built-in parsers for: `tsc`, `eslint`, `pytest-json`, `mypy-json`. Users can add config-referenced parser scripts later.

### Diagnostic-to-node mapping

- File-level diagnostics → file node
- Line-ranged diagnostics inside a symbol → symbol node (tier 3), also rolls up to the containing file (tiers 0–2)
- All tool outputs normalized to repo-relative paths, matched against canonical node IDs

### Aggregation

Health rolls up the hierarchy the same way AI intent does:
- Symbol errors → file `health = "error"`, `health_detail = "3 errors"`
- File errors → module `aggregated_health = { ok: N, warning: M, error: K }`
- Module aggregates → visible at top-level zoom as a subtle red badge

A clean module looks clean at a glance; a broken module is visually loud without drowning everything else.

### Freshness and staleness

If a source stops emitting (process crashed, watcher died), affected nodes revert to `health = "unknown"` after a silence window (default: 30s). Never show phantom stale errors after a fix.

### Diagnostics panel

Clicking a node with `health = "error" | "warning"` opens a side panel with:
- Full diagnostic messages
- Source attribution ("from tsc", "from eslint")
- Line numbers (future: click to jump in the user's editor)

### CC integration

New MCP tool: `arch_health(node_id)` returns diagnostics as structured JSON. CC reads what's broken before suggesting fixes.

When a user has a broken node selected, the UserPromptSubmit hook extends `<arch-context>`:

```
<arch-context>
User focused: parser.ts (Engine)
Current diagnostics: 2 errors
  - Line 42: Type 'string' is not assignable to 'number'
  - Line 78: Property 'foo' does not exist on type 'Bar'
</arch-context>
```

### Lifecycle management

Server owns source-process lifecycle:
- Start on workspace activation (driven by `.schematic.json`)
- Auto-restart on crash (with backoff)
- Stop cleanly on workspace pause/disable or server shutdown
- Restart on `.schematic.json` change

Config validation happens at source-start time — bad config fails loudly rather than silently producing no health data.

---

## 9. Deployment

**Decision: browser tab.**

- Reuses GateStack Pro's WebGL framework (`viewport.ts`, `renderer.ts`, `shaders.ts`, `interaction.ts`, `overlayLayer.ts`) unchanged — same browser runtime, no graphics-API translation.
- Day-1 prototype is feasible.
- Chrome is already in David's workflow.

**If the tab feels buried later:** Chrome extension that opens a chromeless, always-on-top popup via `chrome.windows.create({type:'popup', alwaysOnTop:true})`. ~80% overlay feel, ~0% Electron cost, same web app.

**Electron / Tauri:** only if the product is distributed to other developers. Not on the critical path.

The multi-tenant daemon (see §7) runs in the background independently of whether the browser tab is open. Browser and CC are both clients.

---

## 10. Tech Stack (proposed)

- **Frontend:** Vite + TypeScript, port of GateStack Pro's WebGL framework
- **Server:** Node (or Bun) + WebSocket + HTTP; single multi-tenant daemon, fixed port 7777, local-only
- **Graph source:**
  - File-level imports: `dependency-cruiser` or TS compiler API walker for JS/TS; tree-sitter for multi-language later
  - Symbol-level + call graph: TypeScript compiler API (`getReferencedSymbols`, `findReferences`) on demand
  - Python (future): jedi or tree-sitter
- **Layout:**
  - Auto: force-directed seed (d3-force) with hierarchical bias — modules as containers
  - Manual overrides locked via `manually_positioned`
  - Collision: force-directed push-apart at rest; live iterative displacement during drag
- **Health sources:** built-in `tsc --watch` runner (JSON diagnostics), built-in ESLint runner, generic command runner for user-defined tools; parsers: `tsc`, `eslint`, `pytest-json`, `mypy-json`
- **Mention index:** Aho-Corasick automaton built at graph-build time, updated incrementally on node add/remove, serialized to `mention-index.bin` per workspace
- **Persistence:** flat JSON under `~/.schematic/workspaces/<id>/` — node positions, graph cache, event log, health cache, mention index
- **Hook integration:** shell scripts in the user's **global** Claude Code settings that POST to `localhost:7777/hook` with cwd-tagged payloads
- **MCP server:** stdio transport, registered **once globally** in Claude Code settings
- **CLI:** `schematic` binary exposing `start`, `stop`, `status`, `workspaces list`, `activate`, `pause`, `forget`

---

## 11. Relationship to GateStack Pro

- **Separate repo, separate product.**
- Ports the WebGL infrastructure as a one-time lift — does not modify GateStack Pro.
- Could eventually generalize beyond David's own use into a public developer tool.

---

## 12. Open Questions

All five original open questions are resolved (see §15 History). New sub-questions surfaced during resolution:

- [ ] **`.schematic/` directory structure:** what lives inside? (Proposed: `local-positions.json`, `session-cache/`, user-specific cache — not checked in.)
- [ ] **Port conflict handling:** what if `7777` is in use? Auto-select next free port and update config, or refuse to start?
- [ ] **Workspace-list UI on first visit:** toast-notify the user when a new workspace auto-registers, or silent? Leaning toast once, then silent.
- [ ] **Cross-repo edges (v2):** exact config shape for declaring workspace dependencies. Deferred.
- [ ] **Drift-metric notification (v1.5):** threshold formula for suggesting re-layout. Needs tuning with real graphs.
- [ ] **Symbol-level mention extraction:** at tier 3, should `extractFeatures` in a prompt match the specific symbol, or the containing file? Leaning symbol when tier 3 is loaded, file otherwise.

Resolved:
- ✅ Zoom vs. drill → zoom-continuous, four tiers
- ✅ Granularity floor → function/class symbols
- ✅ Module definition → auto-from-directory + optional `.schematic.json` override
- ✅ Separate OS windows → no, zoom-only within one tab
- ✅ Re-layout trigger → no auto-trigger; incremental placement for new nodes, full re-layout is manual only
- ✅ Drag collision → push-apart physics
- ✅ Multi-select → lasso + ctrl/cmd-click, v1
- ✅ Visual groups → deferred to v2
- ✅ `ai_intent` stacking → stack (halo = intent, brightness = recency)
- ✅ Symbol granularity → yes, lazy extraction on zoom
- ✅ Per-symbol state → yes, four-tier aggregation
- ✅ Health integration → properly scoped: full infra + `tsc --watch` first-class + generic command runner + diagnostics panel + `arch_health` MCP tool
- ✅ Conversation mention extraction → two-sided (UserPromptSubmit + PreToolUse), Aho-Corasick index, schema uses `last_mention_ts`/`last_mention_source`
- ✅ Server model → one multi-tenant daemon on fixed port, cwd-routed
- ✅ Activation → auto-register always, auto-activate on marker, manual otherwise, implicit on browser URL, opt-out via ignore file or global config
- ✅ Pause vs. disable → both, distinct

---

## 13. Build Phases

Phase boundaries are approval gates. Each phase ends with a working demo.

**Phase 0 — Planning (current).** Architecture, schema, naming, scope. This document.

**Phase 1 — Daemon skeleton + workspace model.** Multi-tenant daemon, fixed port, `workspaces.json` registry, state machine (unknown → registered → active → paused → disabled), CLI stub. Persistence layout under `~/.schematic/`. Hook POST endpoint accepts cwd-tagged payloads and routes to workspace.

**Phase 2 — Browser renderer.** Port GateStack Pro WebGL framework. Render a hardcoded graph. Pan, zoom, click-to-select, hover, multi-select via lasso. State-to-visual mapping (color, border, halo, decay).

**Phase 3 — Hook wiring.** Install global Claude Code hooks (`PreToolUse`, `PostToolUse`). End-to-end demo: CC edits a file → hook POSTs to daemon → daemon routes to active workspace → broadcasts WS → browser node flashes yellow→green.

**Phase 4 — Graph extraction.** Real graph from a target repo. Directory-based module detection, optional `.schematic.json` override, file-level import parsing. Graph cached under workspace persistence. Initial-extraction progress streamed to browser.

**Phase 5 — Manual layout.** Drag-with-children, push-apart physics, module auto-fit bounds, user-sized override, `manually_positioned` respected, multi-node bulk drag, incremental placement for new nodes.

**Phase 6 — Zoom tiers + activity propagation.** LOD culling, camera zoom thresholds, cross-layer edge aggregation, 4-level activity rollup from symbol → file → module → top.

**Phase 7 — Symbol-level.** On-demand TypeScript compiler API extraction, tier-3 rendering, call edges, symbol-level node state.

**Phase 8 — CC context integration.** UserPromptSubmit hook injects `<arch-context>`. Two-sided mention extraction: Aho-Corasick index built from graph, matches on user prompts and CC tool inputs, updates `last_mention_ts`. MCP tools: `arch_neighbors`, `arch_impact`, `arch_find`, `arch_get_selection`.

**Phase 9 — Health integration.** Source abstraction, `tsc --watch` runner, generic command runner, diagnostic-to-node mapping, aggregation, freshness/staleness, dashed-outline + error-badge visuals, diagnostics side panel, `arch_health` MCP tool, `.schematic.json` source config.

**Phase 10 — Polish.** Decay tuning, visual refinements, keyboard navigation, search UI, incremental graph updates on file watch, toast notifications, workspace-list UI.

**Phase 11 (optional) — Extension packaging.** Chrome extension wrapper for always-on-top popup window. Login auto-start LaunchAgent.

**v2 candidates:** visual groups, cross-repo edges, drift-metric suggest-relayout, gentle background optimization, multi-user shared layouts, TS config files, Python/other-language first-class support, distribution beyond David's own use.

---

## 14. Design Invariants (non-negotiable)

These must remain true no matter how the design evolves:

1. **CC never has to remember Schematic exists.** All integration is automatic via hooks or context injection.
2. **The server is the single source of truth.** Browser and CC are clients.
3. **The browser tab is optional.** Server and CC stay in sync whether the tab is open or closed.
4. **No pixel coordinates in the CC interface.** CC reads structured state; never screenshots or OCRs the map.
5. **Deterministic state transitions.** Every node color change maps to a specific, replayable event. No heuristics.
6. **User-positioned nodes are sacred.** Auto-layout never moves a manually placed node. Full re-layout is user-triggered only.
7. **The schema never collapses orthogonal dimensions.** AI intent, user selection, focus, health, mention recency stay separate fields; the renderer composes visuals.
8. **Workspace configuration is global, not per-project.** Users install Schematic once. Per-repo activation happens via markers or UI, not re-configuration of CC.

---

## 15. History

- **2026-04-16** — Concept conceived during GateStack Pro SaaS migration session. Decisions landed: name *Schematic*, three-layer integration architecture, browser-tab deployment, full node state schema, zoom-continuous four-tier resolution, auto-from-directory modules with optional override, function/class symbol granularity, manual layout with push-apart collision, multi-select + bulk drag, visual groups deferred to v2. Repo created at `~/Schematic` and `github.com/dvidartist-hub/Schematic` (private).

- **2026-04-16 (continued)** — Five open questions resolved in Q&A walkthrough:
  - **Q1 Health integration:** properly scoped for v1. Full infrastructure (source abstraction, lifecycle management, aggregation, diagnostics panel, `arch_health` MCP tool) with `tsc --watch` as first-class source and generic command runner for everything else.
  - **Q2 Mention extraction:** two-sided via UserPromptSubmit (user) + PreToolUse (CC), Aho-Corasick name-index automaton at graph-build time. Schema change: dropped `conversation_mentions: number` in favor of `last_mention_ts?: number` + `last_mention_source?: "user" | "ai"`.
  - **Q3 Server model:** one multi-tenant daemon on fixed port 7777. Global MCP/hook config, cwd-routed. Users install Schematic once, not per-project.
  - **Q4 Activation:** auto-register always and silently on first hook from new cwd. Auto-activate only if `.schematic.json` or `.schematic/` marker present. Manual activation via UI/CLI otherwise. Implicit activation on browser URL open. Opt-out via `.schematic-ignore` or global config. Pause and disable are distinct states.
  - **Q5 Auto re-layout threshold:** removed. Design error — would have violated Invariant #6. Incremental placement for new nodes is continuous and automatic (push-apart physics). Full re-layout is user-triggered only. Drift-metric notification deferred to v1.5; gentle background optimization to v2.
