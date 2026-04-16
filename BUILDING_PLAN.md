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

- **Nodes** = files / components (rectangles)
- **Edges** = import / dependency relationships (lines)
- **Node state colors** are the shared language of the map:
  - Yellow = AI planning to modify
  - Green = AI successfully modified
  - Red = AI deleted
  - (more states to be defined: user-selected, focus-of-conversation, stale, etc.)
- **Developer clicks a node** → AI knows exactly what is being discussed
- **AI about to edit** → node turns yellow, developer sees the blast radius before the edit lands
- **On commit / file-system change** → graph re-renders with updated relationships

---

## 3. Integration Architecture

The load-bearing design principle: **Claude Code must not have to remember the tool exists.** Every integration point must be structural (harness, hooks, context injection) rather than behavioral (CC remembering to call a tool).

### Topology

```
Browser tab (WebGL view)  ←WebSocket→  Local server  ←MCP + hooks→  Claude Code
```

The **local server is the single source of truth.** Browser and Claude Code are both clients. They never talk to each other directly.

### The three wiring layers

**1. Hooks — write-side, automatic**

- `PreToolUse(Edit|Write)` → node turns yellow
- `PostToolUse(Edit|Write)` success → node turns green
- `PostToolUse(Bash rm/mv)` → node turns red
- CC does nothing. The harness fires the hook; a shell script POSTs to the server; the browser receives the WS update.

**2. MCP server — read-side, on-demand**

- `arch_neighbors(node)` — what imports or depends on this
- `arch_impact(node)` — blast radius of changing it
- `arch_find(query)` — fuzzy locate a component
- `arch_get_selection()` — currently selected nodes
- CC calls these when it genuinely needs graph info. Not the primary integration surface, but present.

**3. UserPromptSubmit hook — read-side, automatic context injection**

- Before every user prompt reaches CC, a hook queries the server for current selection
- Prepends `<arch-context>User focused: viewport.ts, renderer.ts</arch-context>` to the prompt
- CC sees the user's spatial focus automatically, every turn, without being told

### Why claude-in-chrome is NOT in this architecture

claude-in-chrome is for when CC has to *drive a browser like a user* (click, screenshot, read rendered pages). That is the wrong model here. CC does not need to *see* the map; it needs to *read the state*. The server exposes state as structured JSON via MCP. Deterministic, instant, no pixel coordinates, no flakiness.

### Eventual-consistency property

Because the server holds state, CC can keep marking nodes yellow/green even when the browser tab is closed. When the tab reopens, WebSocket reconnects and renders the current state. The map does not require the browser to be live.

---

## 4. Deployment

**Decision: browser tab.**

- Reuses GateStack Pro's WebGL framework (`viewport.ts`, `renderer.ts`, `shaders.ts`, `interaction.ts`, `overlayLayer.ts`) unchanged — same browser runtime, no graphics-API translation
- Day-1 prototype is feasible
- Chrome is already in David's workflow

**If the tab feels buried later:** wrap in a Chrome extension that opens a chromeless, always-on-top popup via `chrome.windows.create({type:'popup', alwaysOnTop:true})`. ~80% of an overlay feel with ~0% of the Electron cost. Same web app.

**Electron / Tauri:** only if the product is eventually distributed to other developers. Not on the critical path.

---

## 5. Tech Stack (proposed)

- **Frontend:** Vite + TypeScript, port of GateStack Pro's WebGL framework
- **Server:** Node (or Bun) + WebSocket + HTTP; single process, local-only for v1
- **Graph source:** AST / import-parse for JS/TS (tools like `dependency-cruiser`, `madge`, or hand-rolled TS compiler API walker); optionally seed from an `ARCHITECTURE.md` Mermaid file
- **Layout algorithm:** force-directed (d3-force) or hierarchical (dagre) — to be decided. Layout runs once, positions are persisted so the graph is stable across sessions.
- **Hook integration:** shell scripts in the user's Claude Code hooks config that POST to `localhost:<port>/hook`
- **MCP server:** stdio transport, registered in Claude Code settings

---

## 6. Relationship to GateStack Pro

- **Separate repo, separate product.** This repo.
- Ports the WebGL infrastructure as a one-time lift — does not modify GateStack Pro.
- Could eventually generalize beyond David's own use into a public developer tool.

---

## 7. Open Questions

These need resolution before code starts.

- [ ] **Graph-build pipeline:** AST walker vs. existing tool (dependency-cruiser, madge). Tradeoff between fidelity and speed.
- [ ] **Layout:** force-directed (organic, reshuffles as graph changes) vs. hierarchical (stable, predictable). Leaning hierarchical for stability.
- [ ] **Node state schema beyond colors:** do we track "last edited," "current conversation focus," "test coverage," etc.?
- [ ] **Scope of the first graph:** a single repo? Monorepo-aware? Cross-repo edges via symlinks or config?
- [ ] **Collaboration bootstrapping:** how does the user first tell CC "we are working in Schematic now"? (Settings flag, environment var, auto-detect by presence of a `.schematic/` directory in the target repo?)
- [ ] **Persistence:** where does the server store node positions and historical state? Local SQLite? Flat JSON? In-memory with snapshot-to-disk?
- [ ] **Multi-project support:** does one running server manage graphs for many repos, or one server per repo?

---

## 8. Build Phases (draft — to be refined)

Phase boundaries are approval gates.

1. **Phase 0 — Planning (current).** Architecture, naming, scope. This document.
2. **Phase 1 — Server skeleton.** Local Node/Bun server, WebSocket, minimal node/edge in-memory store, HTTP POST endpoint for hook events.
3. **Phase 2 — Browser renderer.** Port GateStack Pro WebGL framework. Render a hardcoded node/edge set. Pan, zoom, click-to-select.
4. **Phase 3 — Hook wiring.** Write-side integration: `PreToolUse` / `PostToolUse` → server → browser color update. End-to-end demo: CC edits a file, browser node flashes yellow→green.
5. **Phase 4 — Graph extraction.** AST/import-parse to build the real graph from a target repo. Persist node positions.
6. **Phase 5 — UserPromptSubmit injection.** Browser selection → server → hook → `<arch-context>` in every CC prompt.
7. **Phase 6 — MCP tools.** Expose `arch_neighbors`, `arch_impact`, `arch_find`, `arch_get_selection` so CC can query graph state on demand.
8. **Phase 7 — Polish.** Node state richness, search UI, keyboard navigation, incremental graph updates on file watch.

Each phase ends with a working demo the developer can use. No phase depends on a later phase being partially built.

---

## 9. Design Invariants (non-negotiable)

These are the things that must remain true no matter how the design evolves:

1. **CC never has to remember Schematic exists.** All integration is automatic via hooks or context injection.
2. **The server is the single source of truth.** Browser and CC are clients.
3. **The browser tab is optional.** The server and CC stay in sync with or without the tab open.
4. **No pixel coordinates in the CC interface.** CC reads structured state; it never screenshots or OCRs the map.
5. **Deterministic state transitions.** A node color change maps to a specific, replayable event. No heuristics.

---

## 10. History

- **2026-04-16** — Concept conceived during GateStack Pro SaaS migration session. Name settled: *Schematic*. Integration architecture (three-layer wiring) decided. Deployment (browser tab) decided. Repo created.
