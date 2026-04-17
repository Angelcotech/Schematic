# Schematic — Building Plan

Living planning document. Captures decisions as they are made. No code yet.

See [`USER_SIMULATION.md`](./USER_SIMULATION.md) for the narrative walkthrough that motivated many of the UX specs in this doc.

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
10. [Install, Connection & Browser UX](#10-install-connection--browser-ux)
11. [Tech Stack](#11-tech-stack)
12. [Relationship to GateStack Pro](#12-relationship-to-gatestack-pro)
13. [Open Questions](#13-open-questions)
14. [Build Phases](#14-build-phases)
15. [Design Invariants](#15-design-invariants)
16. [History](#16-history)

---

## 1. Product

**Schematic** is a live reference to what Claude Code is doing structurally and architecturally in your codebase. It renders the repo as a node graph; as CC works, the map reflects activity, health, and focus in real time.

**The gap it closes:** the developer carries the architecture mentally; the AI operates on file paths. The user is effectively blind when directing edits across a large codebase. Schematic is a window that closes that gap — both parties highlight, click, and navigate the same graph.

**Product identity — second screen, not workbench.** Schematic is not a primary interface for interacting with CC. CC continues to run in the user's existing terminal, as usual. Schematic is the **reference surface** — glanceable, peripheral, always-on — showing what CC is changing, where, and whether it's healthy. Like a developer watching a log tail or a health dashboard while they work. Deep interaction (clicking nodes, dragging modules to organize) happens occasionally; glancing happens constantly.

This identity drives priorities: glanceability > interactivity, legibility-at-a-glance > depth-on-click, continuous visual truth > explicit user queries.

**What it is not:**
- Not a codebase visualizer or static diagram renderer — it is a live collaboration surface.
- Not a documentation tool.
- **Not a chat client.** CC runs in the user's existing terminal. Schematic is a reference, not a second place to type to CC. An embedded chat panel is a v2 candidate and may never land — the design works without it.
- Not an editor. Users edit code in their existing editor; CC edits via its tool calls.
- **Not constantly looked at.** Users work in their terminal; Schematic is peripheral. If the design ever requires the user to stare at the map to work effectively, the design is wrong.

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
  ai_intent: "idle" | "reading" | "planning" | "modified" | "deleted" | "failed";
  ai_intent_since?: number;
  ai_intent_tool?: string;        // "Edit" | "Write" | "Read" | "Grep" | "Bash rm" | ...
  ai_intent_session?: string;     // CC session_id that owns this intent

  // User interaction (ephemeral)
  user_state: "none" | "hovered" | "selected";
  // (user_multi_selected cut — multi-select deferred to v1.5)

  // Focus (ephemeral)
  in_arch_context: boolean;       // currently injected into CC prompts
  // (last_mention_ts / last_mention_source cut — mention extraction replaced by "reading" ai_intent)

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

**Symbol extraction is eager with smart caching.** At first activation, the full graph — files, imports, symbols, call edges — is extracted in one pass, with progress streamed to the browser. The result is cached to disk on workspace pause/shutdown. Subsequent activations load the cache instantly (~100ms on a 3k-file graph); the daemon then walks the filesystem, diffs mtimes, and re-parses only changed files. Live edits during a session update incrementally via fs watchers. Rationale: zoom-to-symbol is always instant, the map always shows a complete picture, and the one-time first-extraction cost (~1–3 minutes on typical repos) amortizes across every future session.

For very large repos (10k+ files), tiered readiness keeps things responsive: file-level extraction (tiers 0–2) finishes in ~10–20 seconds and becomes navigable while symbol + call-graph extraction (tier 3) continues in the background. Cache writes also happen when a repo is in `registered` state, so by the time the user clicks Activate, most of the work is already done.

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

- **Drift-metric notification (v1.5):** track a drift score and toast "Layout has gotten cluttered — re-layout?" when it crosses threshold. Never auto-triggers.
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
Browser tab (WebGL view)  ←WebSocket→  Local daemon  ←MCP + hooks→  Claude Code
```

The **local daemon is the single source of truth.** Browser and CC are both clients. They never talk to each other directly.

### Hook payload format

Every hook POSTs to `http://localhost:<port>/hook` with a JSON payload containing at minimum:

```json
{
  "event":      "PreToolUse" | "PostToolUse" | "UserPromptSubmit",
  "tool":       "Edit" | "Write" | "Read" | "Grep" | "Glob" | "Bash" | null,
  "target":     "/abs/path/to/file" | null,
  "cwd":        "/abs/path/to/cwd",
  "session_id": "cc-session-id",
  "timestamp":  1744000000000,
  "success":    true | false | null,     // PostToolUse only
  "prompt":     "raw user text" | null   // UserPromptSubmit only
}
```

`session_id` is the CC session identifier, enabling the daemon to:
- Distinguish multiple simultaneous CC sessions (possibly on the same or different repos)
- Attribute `ai_intent_session` on node state so UI can optionally filter by session
- Scope diagnostic injection per session in multi-session scenarios

The daemon augments the payload with `workspace_id` after cwd-routing.

### Three wiring layers

**1. Hooks — write-side, automatic**

- `PreToolUse(Edit|Write)` → node turns yellow (`ai_intent = "planning"`)
- `PostToolUse(Edit|Write)` success → node turns green (`ai_intent = "modified"`)
- `PostToolUse(Bash rm/mv)` → node turns red (`ai_intent = "deleted"`)
- CC does nothing. The harness fires the hook; a shell script POSTs to the daemon; the browser receives the WS update.

**2. MCP server — read-side, on-demand**

Two tools ship in v1:
- `arch_neighbors(node)` — what imports/depends on this (recursive callers can be traced by walking it)
- `arch_health(node)` — diagnostics for the node (errors, warnings)

`arch_get_selection` is redundant with `<arch-context>` injection (selection is already in every prompt). `arch_find` duplicates CC's Grep/Glob. `arch_impact` is `arch_neighbors` walked. All three deferred — add only if real demand appears.

Tools are layer-aware: queries resolve at the granularity of the node ID passed (module vs. file vs. symbol).

**3. UserPromptSubmit hook — read-side, automatic context injection**

- Before every user prompt reaches CC, a hook queries the daemon for current selection
- Prepends `<arch-context>` to the prompt with current focus and diagnostics
- CC sees the user's spatial focus automatically, every turn, without being told

### "CC activity" signal (replaces mention extraction)

The Aho-Corasick mention extraction was cut in the 2026-04-17 discipline pass. For a reference surface showing "what CC is doing," CC's actual tool calls are the ground truth signal — user intent in advance of CC action is a speculative extra channel we don't need.

Instead: `PreToolUse` hooks set `ai_intent` on the targeted node to one of:
- `"reading"` on `Read`, `Grep`, `Glob`
- `"planning"` on `Edit`, `Write`
- Then `PostToolUse` transitions to `"modified"` / `"failed"` / `"deleted"`

No prompt scanning, no Aho-Corasick index, no two-sided extraction. The renderer reads a single field and composes visuals.

### Why claude-in-chrome is NOT in this architecture

claude-in-chrome is for when CC has to *drive a browser like a user* (click, screenshot, read rendered pages). Wrong model here. CC does not need to *see* the map; it reads state as structured JSON via MCP. Deterministic, instant, no pixel coordinates, no flakiness.

### Eventual-consistency property

The daemon holds all state. CC can keep marking nodes yellow/green even when the browser tab is closed. When the tab reopens, WebSocket reconnects and renders the current state.

### Event stream

All state changes flow as events through the daemon:

```
node.select / node.deselect / node.hover
node.mentioned (source: "user" | "ai")
ai.edit_planned / ai.edit_succeeded / ai.edit_failed / ai.delete
context.node_added / context.node_removed
user.node_moved / user.multi_selected / user.node_resized
fs.modified / fs.deleted
health.updated
workspace.registered / workspace.activated / workspace.paused / workspace.disabled
session.started / session.ended
```

Daemon applies, computes state delta, broadcasts to all clients. Gives you a free undo log, replay for debugging, and an audit trail.

---

## 7. Workspace Model & Daemon

**One multi-tenant daemon** on a fixed port (`7777` by default). Single process manages state for all registered repos. Claude Code integration (MCP + hooks) is configured **once globally** and routes per call based on `cwd`.

### Workspace identity

- Workspace = (repo root path, git remote URL if present)
- Repo root discovery: walk up from `cwd` until `.git/`, `.schematic/`, or `.schematic.json` is found
- Persisted in `~/.schematic/workspaces.json` keyed by workspace ID (hash of root path)

### State machine

Three states. Pre-activation, a workspace simply does not exist in the registry.

| State | Meaning | Hooks applied? | `<arch-context>` injected? |
|-------|---------|---------------|-----------------|
| `active` | Full treatment: graph, health, state | Yes | Yes |
| `paused` | Was active, user paused | No | No (graph cache kept) |
| `disabled` | Opt-out marker present | No | No |

Transitions:
- No record → `active` — first hook from a cwd with `.schematic.json` / `.schematic/` auto-activates; otherwise daemon emits a one-time toast and waits for manual activation (`schematic activate` or UI click), which creates the record as `active`.
- `active ↔ paused` — manual via UI or CLI
- any → `disabled` — via `.schematic-ignore` or global config
- `disabled → paused` — remove `.schematic-ignore` or global config entry; remains paused until user resumes
- any → forgotten — user explicitly removes from registry; workspace persistence directory deleted

The old `unknown` and `registered` states collapsed: a workspace without a record is pre-activation, with no behavioral difference. Eliminating them simplifies the UI (no "grey" workspace pill state), the toast policy, and the state-transition matrix.

### Activation paths

1. **Auto-activation — explicit intent marker.** `.schematic.json` or `.schematic/` present → activate on first touch. This is how a project commits "yes, use Schematic here" alongside the code.
2. **Manual activation — UI / CLI.** No marker → daemon registers silently on first hook. You visit `localhost:7777`, see it in the workspace list, click "Activate." Or run `schematic activate` in the repo.
3. **Implicit activation — browser URL.** Opening `localhost:7777/w/<id>` for a registered workspace activates it (matches user intent without a button click).

### Opt-out

- `.schematic-ignore` file in repo root → permanent `disabled`
- Global `~/.schematic/config.json` with ignored path patterns
- Either wins over any activation signal

### Workspace actions (context menu in workspaces sidebar)

Right-clicking a workspace in the browser sidebar (or via CLI) exposes:

| Action | From state(s) | Effect |
|--------|---------------|--------|
| Activate | `registered` | Triggers graph extraction, starts health sources, state → `active` |
| Pause | `active` | Stops health sources, drops incoming hooks, keeps graph cache; state → `paused` |
| Resume | `paused` | Restarts health sources, accepts hooks again; state → `active` |
| Disable | any | Writes `.schematic-ignore` in repo root; state → `disabled` |
| Enable | `disabled` | Removes `.schematic-ignore`; state → `registered` |
| Re-index | `active` | Full graph rebuild. **Preserves manual positions.** Health sources restart. |
| Forget | any | Removes from registry, deletes `~/.schematic/workspaces/<id>/`. Optional: "keep layout only" retains `positions.json` in case of re-registration. |
| Open in editor | any | Opens repo root in user's configured editor (future integration) |

### Persistence layout

```
~/.schematic/
  config.json              # global settings, ignored paths, port, toast policy
  workspaces.json          # registry: id → { path, name, git_remote, state }
  workspaces/
    <id>/
      positions.json       # manual layout
      graph.json           # cached node/edge data
      events.log           # event stream (capped, rotated)
      health-cache.json    # last known diagnostics
      mention-index.bin    # serialized Aho-Corasick automaton
```

### Daemon lifecycle

- **Start:** auto on first MCP connection (CC triggers it); manual via `schematic start`
- **Run:** idles in background across CC sessions, low resource usage when all workspaces paused
- **Stop:** `schematic stop`; no auto-shutdown (once started, stays running until explicitly stopped or user logs out)
- **CLI:** `schematic start | stop | status | workspaces list | activate | pause | forget <id>`
- **Login auto-start:** optional LaunchAgent (macOS) or equivalent — phase-10 polish, not v1 required

### Initial extraction UX

Activation of a large repo may take a few seconds to index. The daemon:
- Responds immediately to the activation request
- Streams `workspace.extraction_progress` events to the browser
- Progress cadence: every ~500ms or every 100 files/symbols, whichever fires first
- Phases reported: `directory_walk`, `gitignore_apply`, `import_parse`, `mention_index_build`, `health_source_start`
- Each phase can stream sub-progress (`847 / 3,104 files`)
- Browser shows overlay with phase + percent; overlay dismisses on `Ready`
- Health sources start only after `import_parse` completes (they need the graph to map diagnostics to)

No blocking; no timeouts that bite on big repos.

### Cache and incremental update

The graph is **eager + cached**. Full extraction happens once per repo; subsequent sessions are near-instant.

**Cache file schema** (`~/.schematic/workspaces/<id>/graph.json`):

```json
{
  "schema_version": 1,
  "workspace_id": "ws_f2a81c3d",
  "extracted_at": 1744000000000,
  "tsconfig_hash": "sha256:...",
  "package_json_hash": "sha256:...",
  "schematic_json_hash": "sha256:...",
  "files": {
    "src/engine/parser.ts": {
      "mtime": 1743999000000,
      "byte_size": 4821,
      "content_hash": "sha256:..."
    }
  },
  "nodes": [ /* full NodeState[] */ ],
  "edges": [ /* full Edge[] */ ]
}
```

**Invalidation rules** (evaluated at activation):

| Trigger | Effect |
|---------|--------|
| `tsconfig.json` hash changed | Full symbol re-parse (types changed) |
| `package.json` hash changed | Full symbol re-parse (dependencies changed) |
| `.schematic.json` hash changed | Re-group modules, keep file/symbol graph |
| File mtime newer than cache | Re-parse that file only (imports + symbols) |
| File deleted | Drop its nodes + inbound edges |
| File added | Parse fully, insert |
| Cache `schema_version` bumped | Full re-parse |

**Activation flow:**

1. Load cache from disk (~100ms for 3k-file graph)
2. Hash the three config files (tsconfig, package.json, .schematic.json), compare against cache
3. If any differ → full re-parse. Otherwise → proceed.
4. Walk filesystem, stat every tracked file (<1 second for ~3k files)
5. Collect dirty files (mtime newer or content hash mismatch)
6. Collect deleted files, collect new files
7. Re-parse the dirty + new set (usually 0-10 files, <2 seconds)
8. Apply diffs to the in-memory graph
9. Broadcast `workspace.ready` with summary: `X files re-parsed, Y added, Z removed`
10. Start health sources

**Live updates (mid-session):** an `fs.watch` subscription per workspace catches changes as they happen. Save a file → parse it immediately, update the graph, broadcast the delta. No waiting for the next activation.

**Cache persistence:**
- Written atomically on workspace pause, disable, daemon shutdown
- Also on a periodic flush (every 30 seconds of idle, coalesced)
- Atomic: write to `graph.json.tmp` then rename, so a crash mid-write never corrupts the cache

**Cache corruption recovery:** if the cache file is unreadable (truncated, wrong schema version, parse error), the daemon logs a warning, deletes the file, and runs a full re-extraction. No silent failures — the user sees a toast.

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
Diagnostic stream → daemon
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

**One runner class, multiple parsers.** A single `HealthSourceRunner` spawns any shell command in watch mode and pipes output through a named parser. v1 ships with four built-in parsers (`tsc`, `eslint`, `pytest-json`, `mypy-json`). Adding a fifth later is a new parser, not a new runner class.

TypeScript gets first-class treatment via the `tsc` parser — `tsc --watch` emits JSON diagnostics the parser consumes. The runner itself is the same as for any other tool. No separate "tsc-runner" class.

Users declare sources in `.schematic.json`:

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

### Inline diagnostic tooltip (no panel)

Hovering a node with `health = "error" | "warning"` extends the standard hover tooltip with:
- First diagnostic message (one line, truncated if long)
- If more diagnostics exist: `"+N more — run \`tsc\` for full output"`

No dedicated side panel. Deep detail stays in the user's terminal where `tsc --watch` output already lives. Reference surface shows presence and count, not prose.

### CC integration

MCP tool: `arch_health(node_id)` returns diagnostics as structured JSON. CC reads what's broken before suggesting fixes.

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

Daemon owns source-process lifecycle:
- Start on workspace activation (driven by `.schematic.json`)
- Auto-restart on crash (with backoff)
- Stop cleanly on workspace pause/disable or daemon shutdown
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

## 10. Install, Connection & Browser UX

This section specifies the user-visible surface. See `USER_SIMULATION.md` for the narrative walkthrough.

### 10.1 Install CLI

Global install:
```
npm install -g schematic
schematic install
```

`schematic install` performs:
1. Write MCP server entry to `~/.claude/settings.json` (idempotent; skips if already present).
2. Write three hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`) to `~/.claude/settings.json` — each a short shell script that POSTs to `localhost:<port>/hook` with JSON payload.
3. Create `~/.schematic/` directory structure if absent.
4. Start the daemon on port 7777 (or next-free if in use; port persisted to `~/.schematic/config.json`).
5. Print a summary including the dashboard URL, stop command, and help command.

Uninstall:
```
schematic uninstall       # removes MCP entry, hooks, stops daemon; offers to keep ~/.schematic/
npm uninstall -g schematic
```

CLI surface:
```
schematic start | stop | restart | status
schematic install | uninstall
schematic workspaces list | info <id> | forget <id>
schematic activate [path] | pause [path] | resume [path] | disable [path]
schematic config get <key> | set <key> <value>
schematic log [--tail] [--workspace <id>]
```

### 10.2 Connection Model — the three pills

The browser top bar shows three persistent status pills. Together they codify the user's mental model of "is the system working?"

| Pill | States | Meaning | Tooltip shows |
|------|--------|---------|---------------|
| **Daemon** | ● green / ✕ red | Browser↔daemon WS is alive | Uptime, port, session count, events processed |
| **CC activity** | ● green (active in 10s) / ● yellow (active in 60s) / ○ grey (idle) | Has any hook fired recently? | Last hook event + tool, session ID, session age |
| **Workspace** | ● green (active) / ◐ amber (paused) / ○ grey (registered) / ✕ red (error) | State of currently viewed workspace | Files, symbols, health sources, last change |

Click-through on any pill opens a detailed status panel. If something is wrong, the pill color changes and the tooltip explains how to fix it (e.g., daemon red → "Run `schematic start` in your terminal").

### 10.3 Browser layout

```
┌──────────────────────────────────────────────────────────────┐
│ Schematic   ● Daemon   ● CC activity   ● Workspace    [↻]   │ ← top bar
├──┬───────────────────────────────────────────────────────────┤
│  │                                                           │
│ L│                                                           │
│ e│                                                           │
│ f│                                                           │
│ t│           WebGL canvas (map)                              │
│  │                                                           │
│ s│                                                           │
│ i│                                                           │
│ d│                                                           │
│ e│                                                           │
│  │                                                           │
└──┴───────────────────────────────────────────────────────────┘
```

- **Top bar** — three status pills (§10.2) and a re-layout button. That's all. No settings gear (settings are CLI-only).
- **Left sidebar — Workspaces.** List of all registered workspaces with state indicator, recent activity timestamp, health summary. Right-click → context menu (§7). Click a row → switch view. Collapsible. Starts collapsed on first launch.
- **Canvas** — the map. Occupies 95% of the surface. This is what users are looking at.
- **Hover tooltip** — ephemeral, near cursor. Shows node name, one metric, and (if the node has errors) the first diagnostic message plus a "run `tsc` for full output" hint.
- **No right sidebar.** Cut in Round 4. Diagnostics are shown on the map as halos, badges, and in the hover tooltip.
- **No bottom drawer.** Event feed is CLI (`schematic log --tail`). No GUI.
- **No settings panel.** CLI (`schematic config get|set`).

The canvas is the product. Peripheral UI exists only where it genuinely serves the "is this working?" glance.

### 10.4 Toast policy

Opinionated, not configurable in v1.

- **First time a cwd without a marker is detected:** toast with [Activate] [Skip] [Always skip this path]. After that first toast per path, the same path is silent — subsequent CC sessions in the same repo do not re-prompt.
- **"Always skip this path":** writes the path to global config's ignore list → future visits are silent no-ops.
- **Workspace auto-activation on marker:** subtle one-line toast ("GammaGate auto-activated") with [Switch] [Keep viewing current].
- **Errors:** red toast, sticky until dismissed (e.g., "tsc crashed — restarting").

No "toast cadence" setting. No "toast policy" panel. One behavior, tuned sensibly.

### 10.5 Welcome overlay

First-ever browser visit shows a centered overlay:

> **Schematic is listening.**
>
> Open any Claude Code session in a project directory and work normally. Your repo will appear here within a few seconds of the first edit, read, or question.
>
> No per-project setup required.
>
> [Dismiss]

Dismissed state persists to `~/.schematic/config.json`. Not shown again unless explicitly reset via `schematic config set welcome.shown false`.

### 10.6 No GUI settings panel in v1

v1 ships with opinionated defaults and no settings panel. The rarely-edited knobs (port, ignored paths, theme) are CLI-only:

```
schematic config get <key>
schematic config set <key> <value>
```

Settings still persist to `~/.schematic/config.json`, just edited via CLI rather than a GUI form. A settings panel is a v1.5 candidate — not missed by v1 users because the defaults are the right path.

---

## 11. Tech Stack (proposed)

- **Repo layout:** monorepo with **two** workspaces — `app` (CLI + daemon combined) and `frontend`. Shared types live in a plain `app/src/shared/` folder imported relatively. No separate `shared` package, no separate `cli` package.
- **Frontend:** Vite + TypeScript, port of GateStack Pro's WebGL framework
- **Server:** Node (or Bun) + WebSocket + HTTP; single multi-tenant daemon, fixed port 7777 (fallback auto-assigned), local-only
- **Graph source:**
  - File-level imports: `dependency-cruiser` or TS compiler API walker for JS/TS; tree-sitter for multi-language later
  - Symbol-level + call graph: TypeScript compiler API (`getReferencedSymbols`, `findReferences`) on demand
  - Python (future): jedi or tree-sitter
- **Layout:**
  - Auto: force-directed seed (d3-force) with hierarchical bias — modules as containers
  - Manual overrides locked via `manually_positioned`
  - Collision: force-directed push-apart at rest; live iterative displacement during drag
- **Health sources:** built-in `tsc --watch` runner (JSON diagnostics), built-in ESLint runner, generic command runner for user-defined tools; parsers: `tsc`, `eslint`, `pytest-json`, `mypy-json`
- **No mention index.** Cut in Round 4. CC activity is observed directly from hook tool calls, not inferred from prompt/tool-input scanning.
- **Persistence:** flat JSON under `~/.schematic/workspaces/<id>/` — node positions, graph cache, event log, health cache, mention index
- **Hook integration:** shell scripts in the user's **global** Claude Code settings that POST to `localhost:7777/hook` with cwd + session_id-tagged payloads
- **MCP server:** stdio transport, registered **once globally** in Claude Code settings
- **CLI:** `schematic` binary exposing `start`, `stop`, `restart`, `status`, `install`, `uninstall`, `workspaces list/info/forget`, `activate/pause/resume/disable`, `config get/set`, `log`

---

## 12. Relationship to GateStack Pro

- **Separate repo, separate product.**
- Ports the WebGL infrastructure as a one-time lift — does not modify GateStack Pro.
- Could eventually generalize beyond David's own use into a public developer tool.

---

## 13. Open Questions

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
- ✅ Chat interface in Schematic → no, v1 is map+dashboard only; embedded chat is a v2 candidate using Claude Agent SDK
- ✅ Connection visibility → three persistent status pills in top bar (daemon / CC activity / workspace)
- ✅ `session_id` in hook payloads → yes, enables multi-session disambiguation and `ai_intent_session` on node state
- ✅ Install UX → `schematic install` one-command flow, port-conflict fallback, idempotent settings writes

Remaining:
- [ ] **`.schematic/` directory structure:** what lives inside? (Proposed: `local-positions.json`, `session-cache/`, user-specific cache — not checked in.)
- [ ] **Cross-repo edges (v2):** exact config shape for declaring workspace dependencies. Deferred.
- [ ] **Drift-metric notification (v1.5):** threshold formula for suggesting re-layout. Needs tuning with real graphs.
- [ ] **Symbol-level mention extraction:** at tier 3, should `extractFeatures` in a prompt match the specific symbol, or the containing file? With eager extraction, the symbol is always available — leaning "match the symbol, always."
- [ ] **Editor jump integration:** side panel "jump to line" behavior. VS Code URL scheme? Configurable editor hook?
- [ ] **Multi-session concurrency semantics:** if two CC sessions edit the same file concurrently, how do we render competing `ai_intent_session` states? Leaning: union of halos, tooltip shows session list.
- [ ] **Tiered readiness threshold (v2):** at what file count do we switch from single-pass eager extraction to tier-0-2-first-then-tier-3-background? (Gut: 5,000 files.)
- [ ] **Terminal-to-map switching friction:** for single-monitor users, constantly alt-tabbing between CC terminal and Schematic browser is real cognitive cost. `<arch-context>` injection already eliminates the "type the filename" friction — user clicks a node, says "fix it," CC knows what "it" is. But the eye-switching remains. Options: (a) Chrome extension always-on-top popup (planned Stage 13), (b) embedded xterm.js terminal inside Schematic running the user's actual shell (v1.5 candidate if dogfooding proves friction is real), (c) deliberate second-monitor workflow documentation. For v1, assume dual-monitor, keep `<arch-context>` rich, revisit after dogfood.

---

## 14. Build Phases

### Development strategy: self-hosting

**Schematic's own repo is the primary test target.** From Phase 4 onward (graph extraction), every phase is validated against `~/Schematic/` itself:

- The graph extractor indexes Schematic's TypeScript source
- `tsc --watch` runs against Schematic's own tsconfig
- The Aho-Corasick mention index is built over Schematic's own modules and symbols
- CC's edits to Schematic fire hooks that Schematic records on Schematic's own map

This forces realistic complexity (~TypeScript + Node + WebGL + a real dependency graph) from the earliest phases and guarantees the product handles its own codebase before shipping. Dogfooding is the test suite. If Schematic can't usefully visualize Schematic, it can't ship.

Secondary test targets to validate breadth (not every phase, but checked at gate reviews):
- `~/GateStack-Pro/` — larger TypeScript + WebGL codebase
- `~/GammaGate/` — Python + TypeScript mixed (will stress parsers beyond v1 scope but useful as a stretch test)

### Phase list

Phase boundaries are approval gates. Each phase ends with a working demo.

**Phase 0 — Planning (current).** Architecture, schema, naming, scope. This document + `USER_SIMULATION.md`.

**Phase 1 — Daemon skeleton + workspace model + install CLI.**
- Multi-tenant daemon, fixed port with fallback, `workspaces.json` registry
- State machine (unknown → registered → active → paused → disabled)
- Persistence layout under `~/.schematic/`
- Hook POST endpoint accepts cwd + session_id payloads, routes to workspace
- `schematic install` / `uninstall` / `start` / `stop` / `status` commands
- Smoke test: install → run any CC command → hook arrives → daemon logs it with workspace_id

**Phase 2 — Browser renderer + three-pill status bar.**
- Port GateStack Pro WebGL framework
- Render a hardcoded graph; pan, zoom, click-to-select, hover, multi-select via lasso
- Top bar with the three status pills wired to real daemon state
- Event feed bottom drawer
- State-to-visual mapping (color, border, halo, decay)

**Phase 3 — Hook wiring end-to-end.**
- Install hooks globally in CC settings (via `schematic install`)
- End-to-end demo: CC edits a file → hook POSTs to daemon → daemon routes to active workspace → broadcasts WS → browser node flashes yellow→green
- Session-level attribution via `session_id`

**Phase 4 — Full graph extraction + cache layer. First self-hosting milestone.**
- Eager extraction: files, imports, symbols (TypeScript compiler API), call edges — all in one pass per activation
- Directory-based module detection, optional `.schematic.json` override
- Cache layer: atomic writes, version stamps, config-file hashing for invalidation, mtime-based incremental updates
- fs watcher for live mid-session updates
- Initial-extraction progress streamed to browser (phased cadence); tiered readiness for large repos (tiers 0–2 navigable while tier 3 finishes in background)
- **Self-hosting target:** Schematic's own repo is indexed and rendered by the running daemon. From this point forward, Schematic is developed *using* Schematic.

**Phase 5 — Manual layout.**
- Drag-with-children, push-apart physics, module auto-fit bounds, user-sized override
- `manually_positioned` respected, multi-node bulk drag via lasso
- Incremental placement for new nodes
- Position persistence on drop, debounced

**Phase 6 — Zoom tiers + activity propagation.**
- LOD culling, camera zoom thresholds, cross-layer edge aggregation
- 4-level activity rollup from symbol → file → module → top

**Phase 7 — Tier-3 symbol rendering.**
- With symbol + call-edge data already extracted in Phase 4, this phase is rendering only
- Tier-3 node rendering (symbols as nodes within files)
- Call-edge rendering between symbols, aggregation up to file-level edges at lower zoom
- Symbol-level interactions (click a function, see its callers/callees via `arch_neighbors`)

**Phase 8 — CC context integration.**
- UserPromptSubmit hook injects `<arch-context>`
- Two-sided mention extraction: Aho-Corasick index built from graph, matches on user prompts and CC tool inputs, updates `last_mention_ts`
- MCP tools: `arch_neighbors`, `arch_impact`, `arch_find`, `arch_get_selection`

**Phase 9 — Health integration.**
- Source abstraction, `tsc --watch` runner, generic command runner
- Diagnostic-to-node mapping, aggregation, freshness/staleness
- Dashed-outline + error-badge visuals, diagnostics side panel
- `arch_health` MCP tool, `.schematic.json` source config
- **Self-hosting validation:** Schematic's own tsc output drives its own map's health.

**Phase 10 — Polish.**
- Decay tuning, visual refinements, keyboard navigation, search UI
- Incremental graph updates on file watch
- Workspace context menu actions (pause/resume/disable/re-index/forget)
- Toast policy config
- Settings panel
- Welcome overlay first-run logic

**Phase 11 (optional) — Extension packaging + auto-start.**
- Chrome extension wrapper for always-on-top popup window
- Login auto-start LaunchAgent (macOS) / equivalent

**v2 candidates:** visual groups, cross-repo edges, drift-metric suggest-relayout, gentle background optimization, multi-user shared layouts, TS config files, Python/other-language first-class support, embedded chat panel via Claude Agent SDK, editor jump integration, distribution beyond David's own use.

---

## 14b. Build Laws

Governing the *how* of construction, not the *what*. Applied to every stage.

1. **Hardwire connections when reasonable.** Default to static imports, direct function calls, and typed messages. No dynamic dispatch, no plugin registries, no string-based event buses unless the flexibility is immediately required today. Consistent with the existing GammaGate discipline.

2. **Scan for fallbacks after each phase.** After every stage, explicitly audit the code for fallback patterns — try-catch-swallow, silent defaults, retry loops, auto-selection between code paths, "if A fails call B" safety nets. Fallbacks mask real failures with "it just works somehow," which is the opposite of hardwired behavior. Each fallback found is either removed or explicitly justified with a written reason. Log every scan in `FALLBACK_AUDIT.md`.

3. **Connection record.** Maintain `CONNECTIONS.md` as a living registry. Every component: home, inputs, outputs, dependencies, consumers. Every piece has a direction and a home. Before wiring, check the registry. After wiring, update it. The registry is part of the "done" of every sub-step.

---

## 15. Design Invariants (non-negotiable)

These must remain true no matter how the design evolves:

1. **CC never has to remember Schematic exists.** All integration is automatic via hooks or context injection.
2. **The daemon is the single source of truth.** Browser and CC are clients.
3. **The browser tab is optional.** Daemon and CC stay in sync whether the tab is open or closed.
4. **No pixel coordinates in the CC interface.** CC reads structured state; never screenshots or OCRs the map.
5. **Deterministic state transitions.** Every node color change maps to a specific, replayable event. No heuristics.
6. **User-positioned nodes are sacred.** Auto-layout never moves a manually placed node. Full re-layout is user-triggered only.
7. **The schema never collapses orthogonal dimensions.** AI intent, user selection, focus, health, mention recency stay separate fields; the renderer composes visuals.
8. **Workspace configuration is global, not per-project.** Users install Schematic once. Per-repo activation happens via markers or UI, not re-configuration of CC.
9. **The user must always be able to see whether the system is working.** Connection state, session activity, and workspace status are first-class visual affordances (the three-pill top bar), not hidden behind menus or logs. When something is wrong, it must be immediately obvious.

---

## 16. History

- **2026-04-16** — Concept conceived during GateStack Pro SaaS migration session. Name settled: *Schematic*. Core architecture landed: three-layer integration, browser-tab deployment, node state schema, zoom-continuous four-tier resolution, auto-from-directory modules with optional override, function/class symbol granularity, manual layout with push-apart collision, multi-select + bulk drag, visual groups deferred to v2. Repo created at `~/Schematic` and `github.com/dvidartist-hub/Schematic` (private).

- **2026-04-16 (cont.)** — Five open questions resolved in Q&A walkthrough:
  - **Q1 Health:** properly scoped for v1 — full infrastructure, `tsc --watch` first-class source, generic command runner, diagnostics panel, `arch_health` MCP tool.
  - **Q2 Mentions:** two-sided extraction (UserPromptSubmit + PreToolUse), Aho-Corasick index. Schema change: dropped `conversation_mentions: number` in favor of `last_mention_ts?: number` + `last_mention_source?: "user" | "ai"`.
  - **Q3 Server model:** one multi-tenant daemon on fixed port 7777. Global MCP/hook config, cwd-routed.
  - **Q4 Activation:** auto-register silently, auto-activate on marker, manual otherwise, implicit on browser URL, opt-out via `.schematic-ignore` or global config, pause vs. disable distinct.
  - **Q5 Auto re-layout threshold:** removed. Design error — would have violated Invariant #6. Incremental placement only; full re-layout is user-triggered.

- **2026-04-16 (cont.)** — User simulation walkthrough (`USER_SIMULATION.md`) integrated. Nine surfaced gaps folded into the plan:
  - Install CLI spec (`schematic install` one-command flow, idempotent, port-conflict fallback)
  - Three-pill connection model (Daemon / CC activity / Workspace) codified as the user's permanent "is it working?" answer
  - Event feed bottom drawer
  - Toast policy (first-time registration + once-per-day default + per-path skip)
  - Workspace context-menu actions with state transition matrix
  - Progress streaming cadence (500ms or 100 files/symbols, phased)
  - `session_id` added to hook payloads and `ai_intent_session` to node state (multi-session disambiguation)
  - "Not a chat client" made explicit in product framing; embedded chat via Claude Agent SDK deferred to v2
  - New **Design Invariant #9**: the user must always see whether the system is working.

- **2026-04-16 (cont.)** — Development strategy decided: **Schematic is its own primary test target.** From Phase 4 (graph extraction) onward, every phase is validated against the Schematic repo itself. Self-hosting is the test suite. If Schematic can't usefully visualize Schematic, it can't ship.

- **2026-04-16 (cont.)** — Extraction strategy flipped from lazy to **eager + cache**. Original "lazy symbol extraction on zoom" was premature optimization. New model: full graph (files + imports + symbols + call edges) extracted in one pass at first activation (~1–3 minutes on typical repos). Cached to disk on shutdown with config-file hashes and mtime index. Subsequent activations load cache instantly, walk filesystem, re-parse only dirty files (typically <2 seconds). Live updates via fs watcher during session. Phase 7 simplified to tier-3 rendering only — the data is already there. Tiered readiness (tiers 0–2 first, tier 3 background) deferred as v2 optimization for 10k+ file repos.

- **2026-04-17** — **Efficiency pass applied.** David called out a pattern: my designs wire things up that work but are often inefficient. Applied 8 cuts to v1 scope, zero user-visible features lost:
  1. Monorepo collapsed from 4 workspaces (`cli`, `daemon`, `frontend`, `shared`) to 2 (`app`, `frontend`). Shared types live in a folder, not a package.
  2. Event-emitter abstraction dropped — direct state mutation + broadcast + debounced persist. No speculative event bus for undo/replay that nothing calls.
  3. Aho-Corasick mention index not serialized. Rebuilt in memory at activation (~100ms).
  4. Three health-runner classes (`tsc`, `eslint`, `generic`) collapsed to one runner + named parsers.
  5. Workspace state machine collapsed from 5 states (`unknown`, `registered`, `active`, `paused`, `disabled`) to 3 (`active`, `paused`, `disabled`). Pre-activation = no record.
  6. MCP tools cut from 5 (`arch_neighbors`, `arch_impact`, `arch_find`, `arch_get_selection`, `arch_health`) to 2 (`arch_neighbors`, `arch_health`). The rest are derivable or redundant with `<arch-context>`.
  7. GUI settings panel removed from v1. CLI-only via `schematic config get/set`.
  8. GUI event drawer removed from v1. CLI tail via `schematic log --tail`.
  
  Call-graph extraction also split out of Stage 6 into Stage 9b — symbols extracted in first pass, call edges follow if needed. Corresponding design principle saved: **curated smooth, no options.** v1 ships a single opinionated path, not a tree of toggles.

- **2026-04-17** — Terminal-to-map switching surfaced as an open UX concern. `<arch-context>` injection already eliminates the "type the filename" friction (user clicks a node, says "fix it"), but eye-switching remains for single-monitor users. v1 assumes dual-monitor workflow; embedded xterm.js terminal is a v1.5 candidate if dogfood proves the friction real.

- **2026-04-17** — **Product identity crystallized: reference surface, not primary interface.** Schematic is a live reference to what CC is doing architecturally. Users interact with CC through their existing terminal; Schematic is peripheral/glanceable, like a log tail or a health dashboard. §1 updated with this framing and an explicit anti-goal ("not constantly looked at"). Priorities confirmed: glanceability > interactivity.

- **2026-04-17** — **Stage-by-stage audit pass, Rounds 1–4 applied.** David requested a final discipline pass. Applied 14 more cuts across Stages 1–12. Each zero-user-feature-lost, consistent with the reference-surface identity:
  - **Stage 1:** Drop `rangeLoader.ts` port entirely (no viewport-relative streaming needed); strip crosshair from `interaction.ts` to ~15 lines; surgical extract on `overlayLayer.ts` to ~80 lines (not 259).
  - **Stage 2:** Hover tooltip stays minimal (filename + one metric), not rich multi-line.
  - **Stage 4:** Drop `schematic workspaces info <id>` subcommand (redundant with UI).
  - **Stage 7:** Drop user-sized module bounds override; drop multi-select/lasso/bulk drag entirely.
  - **Stage 8:** Drop smooth zoom transitions; snap between tiers.
  - **Stage 9:** Drop symbol search UI; zoom-and-pan is sufficient.
  - **Stage 10:** Drop Aho-Corasick mention extraction entirely. Extend `ai_intent` with `"reading"` value fired by PreToolUse on Read/Grep/Glob. Single field, no two-sided integration. Arch-context simplified to "selected node + its diagnostics only" (<200 tokens).
  - **Stage 11:** Drop diagnostics side panel. Inline hover tooltip shows first error + count + "run `tsc` for full output" hint.
  - **Stage 12:** Drop right sidebar entirely. Drop event drawer. Drop settings panel. Keyboard shortcuts minimized to `Esc`, `+`/`-`, `f` (fit-to-screen). Map is the product; peripheral UI only where it serves the glance.
  - **Schema cleanup:** removed `last_mention_ts`, `last_mention_source`, `user_multi_selected` from NodeState. Added `"reading"` to `ai_intent` union.
  - Stages 3, 5, 6 pass untouched — essential plumbing and live-reference spine.
