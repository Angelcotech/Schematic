# Schematic — Connection Registry

Per Build Law 3: every component in the system has a home, inputs, outputs, dependencies, and consumers. Before wiring anything new, check this registry. After wiring, update it.

Every piece has a direction and a home.

---

## Format

For each component:

- **Home:** relative path within the repo
- **Inputs:** what data or signals flow in, and from where
- **Outputs:** what data or signals flow out, and to where
- **Dependencies:** what it reads from (imports, files, config)
- **Consumers:** what reads from it

Edges point from producer to consumer.

---

## Components

### Monorepo root
- **Home:** `/`
- **Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- **Inputs:** developer commands (`pnpm install`, `pnpm dev`, `pnpm typecheck`, `pnpm build`)
- **Outputs:** delegates to `app/` and `frontend/` workspaces via pnpm
- **Dependencies:** pnpm 9+, Node 20+
- **Consumers:** all workspace packages extend `tsconfig.base.json`

### Shared types (`@shared/*`)
- **Home:** `app/src/shared/`
- **Files:** `node-state.ts` (NodeState + enums), `edge.ts` (Edge + EdgeKind), `index.ts`
- **Inputs:** none (pure type definitions)
- **Outputs:** type-only exports
- **Dependencies:** none
- **Consumers:** `frontend/` (via `@shared/*` path alias in `tsconfig.json` and `vite.config.ts`). Future daemon code in `app/src/daemon/` will also consume.

### App workspace
- **Home:** `app/`
- **Files:** `package.json`, `tsconfig.json` + `src/shared/*`
- **Inputs:** future CLI/daemon code
- **Outputs:** will produce `dist/cli/index.js` (Stage 4) and daemon entry (Stage 3)
- **Dependencies:** TypeScript 5.5+
- **Consumers:** `frontend/` consumes `src/shared/` types; CC consumes the CLI (Stage 4+); hooks POST to the daemon (Stage 3+)

### Frontend workspace
- **Home:** `frontend/`
- **Files:** `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`
- **Inputs:** browser window + user mouse/keyboard events
- **Outputs:** rendered WebGL canvas + Canvas 2D overlay
- **Dependencies:** Vite 5, TypeScript 5.5, `@shared/*` types
- **Consumers:** browser tab at `http://localhost:5173` (dev)

### WebGL viewport (`viewport.ts`)
- **Home:** `frontend/src/webgl/viewport.ts`
- **Inputs:** `ViewportState` (xMin/xMax/yMin/yMax/width/height)
- **Outputs:** updated viewport, pixel↔data conversions
- **Dependencies:** none (pure math)
- **Consumers:** `renderer.ts` (reads uniforms), `overlayLayer.ts` (dataToPixel for labels), `main.ts` (zoom/pan/hit-test)

### WebGL renderer (`renderer.ts`)
- **Home:** `frontend/src/webgl/renderer.ts`
- **Inputs:** `HTMLCanvasElement`, `ViewportState`, draw commands
- **Outputs:** rendered frame on canvas
- **Dependencies:** `shaders.ts` (program source), `viewport.ts` (uniform values), browser WebGL 2
- **Consumers:** `main.ts`; Stage 2 node-renderer + edge-renderer will issue draw commands through it

### WebGL shaders (`shaders.ts`)
- **Home:** `frontend/src/webgl/shaders.ts`
- **Inputs:** none (static source strings)
- **Outputs:** `NODE_VERTEX_SHADER`, `NODE_FRAGMENT_SHADER`, `EDGE_*` aliases
- **Dependencies:** none
- **Consumers:** `renderer.ts` compiles these at startup

### Overlay layer (`overlayLayer.ts`)
- **Home:** `frontend/src/webgl/overlayLayer.ts`
- **Inputs:** host `HTMLElement` (mount parent), `ViewportState` for coord conversions
- **Outputs:** Canvas 2D rendering primitives (label, badge, tooltip)
- **Dependencies:** `viewport.ts` (dataToPixel)
- **Consumers:** `main.ts` for status hint; Stage 2+ for node labels, hover tooltips, error badges

### Entry point (`main.ts`)
- **Home:** `frontend/src/main.ts`
- **Inputs:** browser (canvas element via DOM; mouse, wheel, keyboard events)
- **Outputs:** calls `render` on RAF; mutates local `nodes[]` state; drives overlay tooltip
- **Dependencies:** `webgl/*`, `graph/*`, `state/mock-graph.ts`
- **Consumers:** browser loads via `index.html`

### Mock graph (`mock-graph.ts`)
- **Home:** `frontend/src/state/mock-graph.ts`
- **Inputs:** none (hand-authored fixture)
- **Outputs:** `MOCK_NODES: NodeState[]`, `MOCK_EDGES: Edge[]`
- **Dependencies:** `@shared/index.js` types
- **Consumers:** `main.ts` (source of truth for the local graph during Stage 2; replaced in Stage 6 by real extraction)

### Node renderer (`node-renderer.ts`)
- **Home:** `frontend/src/graph/node-renderer.ts`
- **Inputs:** `GLContext`, `NodeState[]`
- **Outputs:** `NodeBuffers` (halo, fill, border VAOs); draw command list via `nodeDraws`
- **Dependencies:** `webgl/renderer.ts` (GLContext), `@shared/index.js` (NodeState)
- **Consumers:** `main.ts` (builds buffers on load and on state change)

### Edge renderer (`edge-renderer.ts`)
- **Home:** `frontend/src/graph/edge-renderer.ts`
- **Inputs:** `GLContext`, `NodeState[]`, `Edge[]`
- **Outputs:** `EdgeBuffer` VAO; draw command list via `edgeDraw`
- **Dependencies:** `webgl/renderer.ts`, `@shared/index.js`
- **Consumers:** `main.ts`
- **Hard-fail:** throws if an edge references an unknown node (no silent skip)

### Hit test (`hit-test.ts`)
- **Home:** `frontend/src/graph/hit-test.ts`
- **Inputs:** `ViewportState`, `NodeState[]`, mouse pixel coords
- **Outputs:** the hit `NodeState` (or `null`), prioritizing symbol > file > module
- **Dependencies:** `webgl/viewport.ts` (pixelToData)
- **Consumers:** `main.ts` (hover + click)

### Daemon entry (`daemon/index.ts`)
- **Home:** `app/src/daemon/index.ts`
- **Inputs:** none at module load; `startDaemon()` reads config and registry
- **Outputs:** bound HTTP+WS server on configured port; `DaemonHandle` with `stop()`
- **Dependencies:** `persist/config`, `workspaces/registry`, `ws`, `http`
- **Consumers:** `daemon/bin.ts` (pre-CLI), `cli/*` (Stage 4)

### Daemon CLI entry (`daemon/bin.ts`)
- **Home:** `app/src/daemon/bin.ts`
- **Inputs:** process signals (SIGTERM, SIGINT)
- **Outputs:** starts daemon, installs signal handlers for graceful shutdown
- **Dependencies:** `daemon/index.ts`
- **Consumers:** `pnpm --filter @schematic/app daemon` (dev script); replaced by `schematic start` in Stage 4

### HTTP request handler (`daemon/http.ts`)
- **Home:** `app/src/daemon/http.ts`
- **Inputs:** `DaemonContext` (registry, ws, state, startedAt); incoming HTTP requests
- **Outputs:** JSON responses (200 / 400 / 404 / 500); side effects on registry + ws broadcast
- **Routes:** `GET /status`, `GET /workspaces`, `POST /hook`
- **Dependencies:** `workspaces/router`, `workspaces/registry`, `ws`
- **Consumers:** `daemon/index.ts` wires it into the Node HTTP server

### WS broadcaster (`daemon/ws.ts`)
- **Home:** `app/src/daemon/ws.ts`
- **Inputs:** HTTP server (for upgrade), `SchematicEvent` broadcasts from other daemon code
- **Outputs:** WS messages to connected clients
- **Protocol:** client sends `subscribe` with optional workspace_id; server sends `ready` on connect, `event` per broadcast
- **Dependencies:** `ws` library, `shared/ws-messages`, `shared/event`
- **Consumers:** `daemon/index.ts`, `daemon/http.ts` (calls `broadcast()`); browser WS client in Stage 5

### Workspace registry (`daemon/workspaces/registry.ts`)
- **Home:** `app/src/daemon/workspaces/registry.ts`
- **Inputs:** `~/.schematic/workspaces.json` on load; in-memory state mutations
- **Outputs:** `Workspace[]`, atomic writes to disk on every mutation
- **Dependencies:** `persist/paths`, `persist/atomic-write`, `workspaces/state-machine` (transition legality)
- **Consumers:** `http.ts`, `daemon/index.ts`

### State machine (`daemon/workspaces/state-machine.ts`)
- **Home:** `app/src/daemon/workspaces/state-machine.ts`
- **Inputs:** current + desired `WorkspaceState`
- **Outputs:** boolean legality check; hard-fail assertion
- **Dependencies:** none (pure logic)
- **Consumers:** `registry.ts`

### cwd router (`daemon/workspaces/router.ts`)
- **Home:** `app/src/daemon/workspaces/router.ts`
- **Inputs:** a cwd path and the registry
- **Outputs:** matched workspace OR `{shouldAutoActivate, root}` for first-time marker discovery; `newWorkspace(root)` factory
- **Dependencies:** `node:fs/promises`, `node:crypto` (hash for stable IDs), shared types
- **Consumers:** `http.ts` hook handler

### Paths + config + atomic write
- **Home:** `app/src/daemon/persist/`
- **Files:** `paths.ts` (constants), `atomic-write.ts`, `config.ts`
- **Outputs:** `SchematicConfig`, initialized directory structure under `~/.schematic/`
- **Consumers:** registry (save), daemon index (readOrInitConfig), CLI (`cli/commands/config.ts`, `cli/utils/daemon-client.ts`, `cli/commands/install.ts`)

### CLI entry (`cli/index.ts`)
- **Home:** `app/src/cli/index.ts`
- **Inputs:** `process.argv` (subcommand dispatch)
- **Outputs:** delegates to command modules; top-level error boundary
- **Dependencies:** all files under `cli/commands/` and `cli/utils/`
- **Consumers:** `schematic` binary (via `package.json#bin`); dev via `pnpm --filter @schematic/app cli ...`

### CLI commands
- **Home:** `app/src/cli/commands/`
- **Files:** `install.ts`, `uninstall.ts`, `start.ts`, `stop.ts`, `status.ts`, `workspaces.ts`, `state.ts` (activate/pause/resume/disable), `config.ts`, `log.ts`
- **Inputs:** parsed argv values from `cli/index.ts`
- **Outputs:** side effects (daemon HTTP calls, settings.json writes, file writes) + terminal output
- **Dependencies:** `cli/utils/daemon-client.ts`, `cli/utils/settings-writer.ts`, `daemon/persist/config.ts`
- **Consumers:** `cli/index.ts`

### Daemon HTTP client (`cli/utils/daemon-client.ts`)
- **Home:** `app/src/cli/utils/daemon-client.ts`
- **Inputs:** port (from `~/.schematic/config.json`)
- **Outputs:** typed responses from daemon endpoints (`getStatus`, `listWorkspaces`, `createWorkspace`, `transitionWorkspace`, `forgetWorkspace`, `resolveCwd`, `shutdownDaemon`, `isDaemonRunning`)
- **Dependencies:** global `fetch`, `ws` for future log streaming
- **Consumers:** every CLI command that talks to the daemon

### Settings writer (`cli/utils/settings-writer.ts`)
- **Home:** `app/src/cli/utils/settings-writer.ts`
- **Inputs:** absolute hook-script path, current `~/.claude/settings.json`
- **Outputs:** atomically-written `~/.claude/settings.json` with Schematic entries added/removed. Entries tagged `_schematic: "schematic"` for idempotent remove.
- **Dependencies:** `daemon/persist/atomic-write.ts`
- **Consumers:** `install.ts`, `uninstall.ts`

### Hook script template (`cli/hook-template.ts`)
- **Home:** `app/src/cli/hook-template.ts` (template generator); emits to `~/.schematic/hooks/hook.mjs` at install time
- **Inputs:** stdin JSON from Claude Code; daemon port
- **Outputs:** stdout — whatever the daemon's `/hook` endpoint returns (either `{}` or `{hookSpecificOutput: {additionalContext}}` for UserPromptSubmit)
- **Hardwired silence:** on daemon unreachable, exits 0 with empty stdout so CC proceeds normally. Documented as deliberate reference-surface design, not a fallback.
- **Consumers:** Claude Code itself (invokes per PreToolUse / PostToolUse / UserPromptSubmit)

### Bootstrap node store (`daemon/node-store.ts`)
- **Home:** `app/src/daemon/node-store.ts`
- **Inputs:** `Workspace`, `HookPayload` (from the HTTP hook handler)
- **Outputs:** `NodeState` mutations, emitted as `NodeChange` objects for broadcast
- **Behavior:** maintains a per-workspace map of `file_path → NodeState`. Each hook derives an `ai_intent` value (reading / planning / modified / failed / deleted) and updates the corresponding node. Random-scatter positions until layout lands in Stage 7.
- **Dependencies:** `shared/node-state`, `shared/hook-payload`, `shared/workspace`
- **Consumers:** `daemon/http.ts` (applies hooks + serves snapshot at GET /workspaces/:id/nodes), `daemon/decay.ts` (periodic demotion)
- **Scope:** in-memory only, replaced in Stage 6 by persistent graph cache from eager extraction.

### Decay tick (`daemon/decay.ts`)
- **Home:** `app/src/daemon/decay.ts`
- **Inputs:** `NodeStoreRegistry`, `WSBroadcaster`
- **Outputs:** periodic `node.state_change` broadcasts as stale ai_intent values demote to idle
- **Cadence:** 10-second interval (unref'd so decay doesn't hold the event loop)
- **Thresholds:** reading 60s, planning 30s, modified 5min, failed 10min, deleted 10min
- **Consumers:** started by `daemon/index.ts`; stops on shutdown

### Frontend WS client (`frontend/src/state/ws-client.ts`)
- **Home:** `frontend/src/state/ws-client.ts`
- **Inputs:** daemon WS URL, optional workspace_id filter, event callback, state-change callback
- **Outputs:** dispatches SchematicEvents to the callback; reconnects with a fixed finite backoff schedule (1s, 2s, 5s, 10s repeating)
- **Dependencies:** browser `WebSocket`, shared types
- **Consumers:** `frontend/src/main.ts`

### Frontend graph store (`frontend/src/state/graph-store.ts`)
- **Home:** `frontend/src/state/graph-store.ts`
- **Inputs:** WS events, initial snapshot from GET /workspaces/:id/graph
- **Outputs:** Map of NodeState; `subscribe()` fires on any mutation
- **Dependencies:** shared types
- **Consumers:** `frontend/src/main.ts` (renderer reads `store.all()`)

### Extraction pipeline (`daemon/extraction/`)
- **Home:** `app/src/daemon/extraction/{walker,modules,imports,layout,extract}.ts`
- **Inputs:** workspace root path, optional progress callback
- **Outputs:** `ExtractedGraph` — nodes + edges + per-file `{mtime_ms, byte_size}`
- **Dependencies:** `typescript` (AST parser), `ignore` (gitignore-style matching), shared types
- **Behavior:**
  - `walker.ts`: async directory walk, honors `.gitignore` + `.schematic-ignore` + built-in ignores (node_modules, dist, .git, .schematic, etc.); filters to a whitelist of text/code extensions.
  - `modules.ts`: module detection — defaults to top-level-directory grouping, overridable via `.schematic.json` `modules` section.
  - `imports.ts`: TS compiler API parses each source file; handles `import`/`export`/`import = require`/`import()`/`require()`. `linkImports` resolves relative specifiers to in-workspace node IDs with .js→.ts substitution for TypeScript projects.
  - `layout.ts`: deterministic grid (modules in a horizontal row, files stacked inside each module). Stage 7 replaces with force-directed.
  - `extract.ts`: orchestrator, emits progress events.
- **Consumers:** `daemon/workspaces/activate.ts`

### Graph cache (`daemon/cache/graph-cache.ts`)
- **Home:** `app/src/daemon/cache/graph-cache.ts`
- **Inputs:** workspace ID, extracted graph to persist; workspace root for config hashing
- **Outputs:** `CachedGraph` (readCache), persisted `~/.schematic/workspaces/<id>/graph.json`
- **Behavior:** SHA-256 of tsconfig.json, package.json, .schematic.json drives invalidation. Atomic writes via `atomic-write.ts`. Corrupt cache → warn + return null → triggers full re-extract.
- **Consumers:** `daemon/workspaces/activate.ts`

### FS watcher (`daemon/fs-watch/watcher.ts`)
- **Home:** `app/src/daemon/fs-watch/watcher.ts`
- **Inputs:** workspace root, batch callback
- **Outputs:** coalesced `{added, changed, removed}` batches every ~150ms
- **Dependencies:** `chokidar`
- **Consumers:** `daemon/workspaces/activate.ts` (per-workspace watcher lifecycle)

### Activation manager (`daemon/workspaces/activate.ts`)
- **Home:** `app/src/daemon/workspaces/activate.ts`
- **Inputs:** `Workspace` to activate/deactivate; events from the fs watcher
- **Outputs:** broadcasts `workspace.extraction_progress` and `workspace.graph_ready`; mutates per-workspace node store via `applyExtractedGraph`
- **Behavior:** cache-first activation (cache-hit restore → emitReady; cache-miss full extract → persist → emitReady). Starts per-workspace fs watcher; triggers full re-extract on any file change. `inProgress` guard prevents concurrent activations of the same workspace.
- **Dependencies:** `extraction/extract`, `cache/graph-cache`, `fs-watch/watcher`, `node-store`, `ws`
- **Consumers:** `daemon/index.ts` (startup activation), `daemon/http.ts` (POST /workspaces, state transitions, forget, auto-activation on hook)

---

## Cross-boundary connections

_(empty — populated as boundaries are defined)_

### CC ↔ Daemon
- **Transport (Stage 3):** HTTP POST to `localhost:<port>/hook`. Payload schema in `shared/hook-payload.ts`. Hook scripts are Stage 5.
- **Transport (Stage 10):** MCP stdio — separate channel. Not wired yet.

### Daemon ↔ Browser
- **Transport:** WebSocket at `ws://localhost:<port>/ws`.
- **Client → Server:** `{ type: "subscribe", workspace_id? }`
- **Server → Client:** `{ type: "ready", server_time }` on connect; `{ type: "event", event: SchematicEvent }` per broadcast.
- **Browser WS client:** not yet implemented; added in Stage 5.

### Daemon ↔ Filesystem
_(to be recorded in Stage 6)_

### Daemon ↔ CC (via MCP)
_(to be recorded in Stage 10)_

### Daemon ↔ Health sources
_(to be recorded in Stage 11)_

---

## Update log

| Date | Stage | What changed |
|------|-------|--------------|
| 2026-04-17 | 0 | Initial empty registry |
| 2026-04-17 | 1.1 | Monorepo root added (package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore) |
| 2026-04-17 | 1.2 | `app/` workspace + shared types (`NodeState`, `Edge` interfaces) |
| 2026-04-17 | 1.3 | `frontend/` workspace skeleton (Vite, TS, index.html, empty main.ts) |
| 2026-04-17 | 1.5-1.7 | WebGL port: `viewport.ts`, `shaders.ts`, `renderer.ts`, `overlayLayer.ts` (written fresh, not literal copies — GateStack source was deeply trading-specific) |
| 2026-04-17 | 1.9 | `main.ts` smoke test: blank WebGL canvas, pan/zoom, status hint overlay |
| 2026-04-17 | 1.x | Favicon: inline SVG data-URL (3-node graph glyph) in `index.html` |
| 2026-04-17 | 2.1 | `state/mock-graph.ts` — 11 nodes (3 modules + 8 files) with 11 edges |
| 2026-04-17 | 2.2 | `graph/node-renderer.ts` — halo / fill / border triangle meshes per NodeState |
| 2026-04-17 | 2.3 | `graph/edge-renderer.ts` — gl.LINES mesh per Edge |
| 2026-04-17 | 2.4 | `graph/hit-test.ts` — O(n) AABB pixel→node with kind priority |
| 2026-04-17 | 2.5-2.7 | `main.ts` rewritten: graph render loop, hover, click-select, Space cycles ai_intent, Esc deselects, F fits to screen |
| 2026-04-17 | 2.x | Zoom tuning: accumulator+threshold pattern ported from GateStack Pro (80-unit threshold, 1.08 factor per step). `viewport.zoom()` fixed to anchor on cursor data point. Halo scaled as fraction of node size, colors more saturated. |
| 2026-04-17 | 3.1-3.8 | Daemon skeleton: app workspace scaffolding, HTTP (status/workspaces/hook), WebSocket (ready + event broadcast), workspace registry with 3-state machine, cwd router with marker-based auto-activation, config + atomic persistence, SIGTERM/SIGINT graceful shutdown. Shared types: Workspace, HookPayload, SchematicEvent, WS messages. |
| 2026-04-17 | 4.1-4.8 | Install CLI. New daemon endpoints: POST /shutdown, POST /workspaces (create), POST /workspaces/:id/state, DELETE /workspaces/:id, GET /resolve. POST /hook now accepts CC-native payload shape and returns hookSpecificOutput for UserPromptSubmit. CLI: start/stop/restart/status, install/uninstall, workspaces list/forget, activate/pause/resume/disable, config get/set, log --tail. Install writes hook.mjs to ~/.schematic/hooks/ and idempotent Schematic-tagged entries to ~/.claude/settings.json. Live-tested end-to-end against real ~/.claude/settings.json (backed up + restored). |
| 2026-04-17 | 5.1-5.7 | Hook wiring end-to-end. Daemon: NodeStoreRegistry + WorkspaceNodeStore (per-workspace NodeState map driven by hooks), startDecayTick broadcasts decay events at 10s cadence, POST /hook now also produces node.state_change events, new GET /workspaces/:id/nodes endpoint, CORS headers added so Vite dev origin can fetch. Frontend: DaemonWSClient with finite reconnect backoff, GraphStore subscribed to renderer, main.ts rewritten to drive from live store. Router bug fixed — `.schematic/` directory no longer a marker (conflicted with ~/.schematic/). Live-tested: CC edits reflect on canvas within ~100ms. |
| 2026-04-17 | 6.1-6.13 | Full graph extraction + cache. Added `extraction/{walker,modules,imports,layout,extract}.ts`, `cache/graph-cache.ts`, `fs-watch/watcher.ts`, `workspaces/activate.ts`. Daemon now eagerly extracts the real graph (files + imports) for each active workspace, caches to disk with config-hash invalidation, and re-extracts on fs changes. New events: workspace.extraction_progress, workspace.graph_ready. New endpoint: GET /workspaces/:id/graph. WorkspaceNodeStore gained edges + applyExtractedGraph (preserves ai_intent + user_state + manual positions across re-extraction). Frontend shows progress bar during extraction and re-fetches graph on graph_ready. Deps added: typescript (runtime, AST parser), chokidar (fs watch), ignore (gitignore matching). `.schematic.json` committed at repo root with App/Frontend/Docs module definitions — self-hosting live. Self-verified: 72 nodes, 110 edges on Schematic's own repo. |
| 2026-04-17 | 7.1-7.9 | Manual layout. Drag a module → its children follow as one unit; other modules push apart via AABB overlap resolution on the shorter axis. On drop, positions POST to the daemon and persist in `~/.schematic/workspaces/<id>/positions.json` (separate from graph.json so drags don't force a full graph rewrite). On activation, positions.json is applied over extracted/cached nodes and those nodes get manually_positioned=true. New endpoints: POST /workspaces/:id/positions, POST /workspaces/:id/relayout. Re-layout clears both positions.json and graph.json then re-activates → fresh grid. Re-layout button rendered in the top-right of the overlay. Gate: positions survive daemon restart; re-layout wipes cleanly. |
| 2026-04-17 | 8.1-8.5 | Zoom tiers + activity propagation. `graph/aggregation.ts` rolls leaf state into module aggregates (aggregated_ai_intent, aggregated_health, aggregated_activity_count/ts + a render-only `_aggregatedHaloIntent` shim for halo color). Two-tier LOD: tier 0 shows only modules + aggregated module↔module edges; tier 1 shows everything. Tier selected by pixel threshold on smallest file width (55px cutoff). Buffers rebuild only on tier transition. Module halos use a reduced pad (4% vs 22% for leaves) so aggregate glow doesn't dwarf contents. Module labels rendered as dark rounded pills ABOVE each module with an inline red error-count badge when `aggregated_health.error > 0`. Smooth transitions remain cut per efficiency pass (snap between tiers). |
