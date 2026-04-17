# Schematic — Building Plan

Living planning document. Captures decisions as they are made. No code yet.

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
  conversation_mentions: number;  // decays over time

  // Aggregated state (for parents — rolled up from descendants)
  aggregated_ai_intent: "idle" | "active";
  aggregated_activity_count: number;
  aggregated_activity_ts: number;

  // Health (derived, refreshed periodically)
  health: "ok" | "warning" | "error" | "unknown";
  health_detail?: string;

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

**Visual encoding is composed from state, not stored.** The renderer reads the dimensions and decides: base fill from language, border from `user_state`, halo from `ai_intent`, brightness from time since `last_ai_touch`, dashed outline from `health`, etc. Visual rules can change without schema churn.

**Decay is first-class.** `ai_intent = "modified"` auto-demotes to `"idle"` after ~5 minutes with fading brightness. `in_arch_context` flips off when CC's next prompt no longer includes the node. `conversation_mentions` halves every ~10 minutes. Without decay, the map becomes a christmas tree.

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

### Manual-vs-auto principle

Once a user has moved a node, that position is **sacred**. Auto-layout never repositions it again. New nodes appearing later (new files in the repo) get auto-placed in the least-occupied area near their nearest neighbor — existing user-positioned nodes are untouched.

### Automatic re-layout trigger

When the count of new (unplaced) nodes crosses a threshold (e.g., >20 new files appear since last layout pass), the auto-layout re-runs — but only repositions non-manual nodes. User-positioned nodes stay fixed. A toast notifies the user that placement happened.

### Multi-select and bulk drag (v1)

- **Lasso select:** shift-drag on empty canvas draws a rectangle; all nodes within are multi-selected.
- **Ctrl/Cmd-click:** adds/removes individual nodes from multi-selection.
- **Bulk drag:** dragging any multi-selected node moves all selected nodes together, preserving relative positions.

### Visual groups (deferred to v2)

A `visual_group` kind would let users lasso-select unrelated files and label them as a cluster ("payment flow") with no filesystem backing, persisted under a `visual_groups` key in `.schematic.json`. **Deferred.** v1 ships without this — not required for the core collaboration loop.

### Broadcast cadence

- **During drag:** no intermediate broadcasts. Local render only.
- **On drag end:** one `user.node_moved(id, x, y, bounds?)` event broadcasts, server persists with ~500ms debounce.
- CC is **position-blind** by default — node positions don't appear in `arch_context`. CC cares about *what* the user is focused on, not *where* nodes are drawn.

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
- Layer-aware: queries resolve at the granularity of the node ID passed (module vs. file vs. symbol).

**3. UserPromptSubmit hook — read-side, automatic context injection**

- Before every user prompt reaches CC, a hook queries the server for current selection
- Prepends `<arch-context>User focused: Engine module, specifically parser.ts</arch-context>` to the prompt
- CC sees the user's spatial focus automatically, every turn, without being told

### Why claude-in-chrome is NOT in this architecture

claude-in-chrome is for when CC has to *drive a browser like a user* (click, screenshot, read rendered pages). Wrong model here. CC does not need to *see* the map; it reads state as structured JSON via MCP. Deterministic, instant, no pixel coordinates, no flakiness.

### Eventual-consistency property

The server holds all state. CC can keep marking nodes yellow/green even when the browser tab is closed. When the tab reopens, WebSocket reconnects and renders the current state.

### Event stream

All state changes flow as events through the server:

```
node.select / node.deselect / node.hover
ai.edit_planned / ai.edit_succeeded / ai.edit_failed / ai.delete
context.node_added / context.node_removed
user.node_moved / user.multi_selected / user.node_resized
fs.modified / fs.deleted
health.updated
```

Server applies, computes state delta, broadcasts to all clients. Gives you a free undo log, replay for debugging, and an audit trail.

---

## 7. Deployment

**Decision: browser tab.**

- Reuses GateStack Pro's WebGL framework (`viewport.ts`, `renderer.ts`, `shaders.ts`, `interaction.ts`, `overlayLayer.ts`) unchanged — same browser runtime, no graphics-API translation.
- Day-1 prototype is feasible.
- Chrome is already in David's workflow.

**If the tab feels buried later:** Chrome extension that opens a chromeless, always-on-top popup via `chrome.windows.create({type:'popup', alwaysOnTop:true})`. ~80% overlay feel, ~0% Electron cost, same web app.

**Electron / Tauri:** only if the product is distributed to other developers. Not on the critical path.

---

## 8. Tech Stack (proposed)

- **Frontend:** Vite + TypeScript, port of GateStack Pro's WebGL framework
- **Server:** Node (or Bun) + WebSocket + HTTP; single process, local-only for v1
- **Graph source:**
  - File-level imports: `dependency-cruiser` or TS compiler API walker for JS/TS; tree-sitter for multi-language later
  - Symbol-level + call graph: TypeScript compiler API (`getReferencedSymbols`, `findReferences`) on demand
  - Python (future): jedi or tree-sitter
- **Layout:**
  - Auto: force-directed seed (d3-force) with gentle hierarchical bias — modules as containers
  - Manual overrides locked via `manually_positioned`
  - Collision: force-directed push-apart at rest; live iterative displacement during drag
- **Persistence:** local SQLite or flat JSON under `~/.schematic/<repo-hash>/` — node positions, `.schematic.json` caches, event log
- **Hook integration:** shell scripts in the user's Claude Code hooks config that POST to `localhost:<port>/hook`
- **MCP server:** stdio transport, registered in Claude Code settings

---

## 9. Relationship to GateStack Pro

- **Separate repo, separate product.**
- Ports the WebGL infrastructure as a one-time lift — does not modify GateStack Pro.
- Could eventually generalize beyond David's own use into a public developer tool.

---

## 10. Open Questions

- [ ] **Node state schema — `health`:** external linter/typecheck integration is a later feature. Drop from v1 and add later, or stub with `"unknown"` throughout?
- [ ] **Conversation mention extraction:** UserPromptSubmit hook regex for filenames in the prompt. Simple, imperfect, good enough for v1?
- [ ] **Multi-project support:** does one running server manage graphs for many repos, or one server per repo? (Leaning toward one-server-per-repo for v1 simplicity.)
- [ ] **How does CC first learn "we are working in Schematic now" for a given repo?** Auto-detect via presence of `.schematic/` directory? Environment var? Settings flag?
- [ ] **Auto re-layout threshold:** what count of new unplaced nodes triggers it? (Gut feel: 20. Needs tuning once real repos are loaded.)

Resolved:
- ✅ Zoom vs. drill → zoom-continuous, four tiers
- ✅ Granularity floor → function/class symbols
- ✅ Module definition → auto-from-directory + optional `.schematic.json` override
- ✅ Separate OS windows → no, zoom-only within one tab
- ✅ Re-layout trigger → automatic above threshold
- ✅ Drag collision → push-apart physics
- ✅ Multi-select → lasso + ctrl/cmd-click, v1
- ✅ Visual groups → deferred to v2
- ✅ `ai_intent` stacking → stack (halo = intent, brightness = recency)
- ✅ Symbol granularity → yes, lazy extraction on zoom
- ✅ Per-symbol state → yes, four-tier aggregation

---

## 11. Build Phases

Phase boundaries are approval gates. Each phase ends with a working demo.

**Phase 0 — Planning (current).** Architecture, schema, naming, scope. This document.

**Phase 1 — Server + Hook Wiring.** Local Node/Bun server, WebSocket + HTTP endpoints, minimal in-memory node/edge store, event stream plumbing. Hook scripts installed in Claude Code settings. End-to-end smoke test: CC edits a file → server receives hook POST → broadcasts WS event → test client logs it.

**Phase 2 — Browser Renderer.** Port GateStack Pro WebGL framework. Render a hardcoded graph. Pan, zoom, click-to-select, hover, multi-select via lasso. State-to-visual mapping (color, border, halo, decay).

**Phase 3 — Graph Extraction.** Real graph from a target repo. Directory-based module detection, optional `.schematic.json` override, file-level import parsing. Graph persisted under `~/.schematic/<repo-hash>/`.

**Phase 4 — Manual Layout.** Drag-with-children, push-apart physics, module auto-fit bounds, user-sized override, `manually_positioned` respected by re-layout, multi-node bulk drag. Position persistence on drop.

**Phase 5 — Zoom Tiers + Activity Propagation.** LOD culling, camera zoom thresholds, cross-layer edge aggregation, 4-level activity rollup from symbol → file → module → top.

**Phase 6 — Symbol-Level.** On-demand TypeScript compiler API extraction, tier-3 rendering, call edges, symbol-level node state.

**Phase 7 — CC Context Integration.** UserPromptSubmit hook injects `<arch-context>`. MCP tools: `arch_neighbors`, `arch_impact`, `arch_find`, `arch_get_selection`.

**Phase 8 — Polish.** Decay tuning, visual refinements, keyboard navigation, search UI, health integration (linter/typecheck wire-in), incremental graph updates on file watch.

**Phase 9 (optional) — Extension packaging.** Chrome extension wrapper for always-on-top popup window.

**v2 candidates (not in v1):** visual groups, multi-user shared layouts, cross-repo edges, TS config files, Python/other-language support, distribution beyond David's own use.

---

## 12. Design Invariants (non-negotiable)

These must remain true no matter how the design evolves:

1. **CC never has to remember Schematic exists.** All integration is automatic via hooks or context injection.
2. **The server is the single source of truth.** Browser and CC are clients.
3. **The browser tab is optional.** Server and CC stay in sync whether the tab is open or closed.
4. **No pixel coordinates in the CC interface.** CC reads structured state; never screenshots or OCRs the map.
5. **Deterministic state transitions.** Every node color change maps to a specific, replayable event. No heuristics.
6. **User-positioned nodes are sacred.** Auto-layout never overrides manual placement. The user's spatial organization is inviolable.
7. **The schema never collapses orthogonal dimensions.** AI intent, user selection, focus, and health stay separate fields; the renderer composes visuals.

---

## 13. History

- **2026-04-16** — Concept conceived during GateStack Pro SaaS migration session. Decisions landed: name *Schematic*, three-layer integration architecture, browser-tab deployment, full node state schema, zoom-continuous four-tier resolution, auto-from-directory modules with optional override, function/class symbol granularity, manual layout with push-apart collision, multi-select + bulk drag, visual groups deferred to v2. Repo created at `~/Schematic` and `github.com/dvidartist-hub/Schematic` (private).
