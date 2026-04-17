# Schematic — Build Steps

The step-by-step construction manual. Sibling to [`BUILDING_PLAN.md`](./BUILDING_PLAN.md) (architecture/spec) and [`USER_SIMULATION.md`](./USER_SIMULATION.md) (UX narrative).

- **BUILDING_PLAN.md** answers *what we are building and why.*
- **USER_SIMULATION.md** answers *what it feels like to use.*
- **BUILDSTEP.md** (this doc) answers *what to literally do next, in order.*

---

## Contents

- [How to use this doc](#how-to-use-this-doc)
- [Project layout (target)](#project-layout-target)
- [Stage mapping](#stage-mapping-buildstep--building_plan-phases)
- [Stage 0 — Prerequisites (complete)](#stage-0--prerequisites-complete)
- [Stage 1 — Port GateStack Pro WebGL framework](#stage-1--port-gatestack-pro-webgl-framework)
- [Stage 2 — Render a hardcoded node graph](#stage-2--render-a-hardcoded-node-graph)
- [Stage 3 — Daemon skeleton + workspace state machine](#stage-3--daemon-skeleton--workspace-state-machine)
- [Stage 4 — Install CLI](#stage-4--install-cli)
- [Stage 5 — Hook wiring end-to-end](#stage-5--hook-wiring-end-to-end)
- [Stage 6 — Full graph extraction + cache layer](#stage-6--full-graph-extraction--cache-layer)
- [Stage 7 — Manual layout](#stage-7--manual-layout)
- [Stage 8 — Zoom tiers + activity propagation](#stage-8--zoom-tiers--activity-propagation)
- [Stage 9 — Tier-3 symbol rendering](#stage-9--tier-3-symbol-rendering)
- [Stage 10 — CC context integration (MCP + arch-context)](#stage-10--cc-context-integration-mcp--arch-context)
- [Stage 11 — Health integration](#stage-11--health-integration)
- [Stage 12 — UX polish](#stage-12--ux-polish)
- [Stage 13 — Distribution (optional)](#stage-13--distribution-optional)

---

## How to use this doc

Each stage has:
- **Goal** — one sentence, what is being built
- **Unlocks** — what becomes possible after this stage
- **Dependencies** — stages that must be complete first
- **Parallelizable with** — stages that can run concurrently
- **Sub-steps** — concrete, ordered actions with file paths and code sketches
- **Gate criteria** — the demo conditions to move on
- **Self-hosting check** — what to verify on Schematic's own repo

Stages are sequential by default. Where parallelism is called out, it is intentional — not all stages strictly depend on their predecessors.

**Self-hosting is the test suite.** From Stage 6 onward, every stage is validated by running Schematic on the Schematic repo. Do not proceed through a gate if self-hosting regresses.

**Surgery model.** Every code change — especially in Stage 1 where we are porting someone else's code — should be reviewed diff-by-diff before landing. Do not batch changes; small commits per sub-step.

---

## Project layout (target)

This is the directory structure Schematic grows into. Not every directory exists at Stage 1 — they come online over time. Referenced paths in later stages assume this layout.

```
~/Schematic/
  README.md
  BUILDING_PLAN.md
  USER_SIMULATION.md
  BUILDSTEP.md
  package.json                  # workspace root
  tsconfig.base.json            # shared TS config
  .gitignore
  .schematic.json               # self-config (dogfood)
  
  cli/                          # `schematic` CLI binary
    src/
      index.ts                  # entry
      commands/
        install.ts
        uninstall.ts
        start.ts / stop.ts / restart.ts / status.ts
        workspaces.ts
        config.ts
        log.ts
      utils/
        settings-writer.ts      # safely edits ~/.claude/settings.json
        port-picker.ts
    package.json
    tsconfig.json
  
  daemon/                       # background server
    src/
      index.ts                  # entry, port bind
      http.ts                   # /hook, /status, /workspaces, ...
      ws.ts                     # WebSocket server + broadcast
      mcp.ts                    # MCP stdio server
      workspaces/
        registry.ts             # workspaces.json
        state-machine.ts        # state transitions
        router.ts               # cwd → workspace lookup
      extraction/
        walker.ts               # directory walk + gitignore
        imports.ts              # file-level import parser
        symbols.ts              # TS compiler API symbol extractor
        call-graph.ts           # symbol-to-symbol edges
        module-detect.ts        # directory + .schematic.json
        mention-index.ts        # Aho-Corasick build + serialize
      cache/
        graph-cache.ts          # read/write/invalidate
        atomic-write.ts
      health/
        source.ts               # HealthSource interface
        tsc-runner.ts
        eslint-runner.ts
        generic-runner.ts
        parsers/
          tsc-json.ts
          eslint-json.ts
          pytest-json.ts
          mypy-json.ts
        aggregation.ts
      events/
        emitter.ts              # typed event bus
        persist.ts              # events.log rotation
      fs-watch/
        watcher.ts              # per-workspace file watcher
      utils/
        paths.ts / debounce.ts / hash.ts
    package.json
    tsconfig.json
  
  frontend/                     # browser app
    index.html
    vite.config.ts
    src/
      main.ts                   # entry
      app.ts                    # top-level app
      webgl/                    # ported from GateStack Pro
        viewport.ts             # direct port
        renderer.ts             # direct port
        shaders.ts              # rewritten for nodes/edges
        interaction.ts          # direct port
        overlayLayer.ts         # adapted (labels, badges)
        axes.ts                 # adapted or removed
      graph/
        node-renderer.ts        # rectangle geometry
        edge-renderer.ts        # line geometry
        layout/
          force-directed.ts
          push-apart.ts
          persist.ts
        hit-test.ts             # pixel → node ID
      state/
        graph-store.ts          # local in-memory graph
        ws-client.ts            # daemon connection
        subscriptions.ts
      ui/
        top-bar.ts              # three status pills
        left-sidebar.ts         # workspaces
        right-sidebar.ts        # diagnostics
        event-drawer.ts
        welcome-overlay.ts
        settings.ts
        toast.ts
        context-menu.ts
      workspaces/
        switcher.ts
    package.json
    tsconfig.json
  
  shared/                       # types shared daemon ↔ frontend
    src/
      types/
        node-state.ts
        edge.ts
        event.ts
        hook-payload.ts
        workspace.ts
        health.ts
        arch-context.ts
      protocol/
        ws-messages.ts
        mcp-tools.ts
    package.json
    tsconfig.json
  
  scripts/
    strip-gatestack.sh          # one-shot utility for Stage 1
    self-host-check.sh          # runs schematic on its own repo
```

This is a monorepo with four workspaces: `cli`, `daemon`, `frontend`, `shared`. Managed via pnpm or bun workspaces (decide in Stage 1). Shared types live in `shared/` so the daemon and frontend can't drift.

---

## Stage mapping (BUILDSTEP ↔ BUILDING_PLAN phases)

BUILDSTEP reorders BUILDING_PLAN's phases for actual implementation — port-first gives us something visible to navigate against, before the daemon exists.

| BUILDSTEP stage | BUILDING_PLAN phase |
|-----------------|---------------------|
| Stage 1 — Port WebGL | Phase 2 (first half) |
| Stage 2 — Hardcoded render | Phase 2 (second half) |
| Stage 3 — Daemon skeleton | Phase 1 |
| Stage 4 — Install CLI | Phase 1 (CLI portion) |
| Stage 5 — Hook wiring | Phase 3 |
| Stage 6 — Graph extraction + cache | Phase 4 |
| Stage 7 — Manual layout | Phase 5 |
| Stage 8 — Zoom tiers + propagation | Phase 6 |
| Stage 9 — Tier-3 rendering | Phase 7 |
| Stage 10 — CC context | Phase 8 |
| Stage 11 — Health | Phase 9 |
| Stage 12 — Polish | Phase 10 |
| Stage 13 — Distribution | Phase 11 |

---

## Stage 0 — Prerequisites (complete)

Done as of 2026-04-16:
- Local repo at `~/Schematic/`, remote at `github.com/dvidartist-hub/Schematic` (private)
- `README.md`, `BUILDING_PLAN.md`, `USER_SIMULATION.md`, `BUILDSTEP.md`
- All five architectural open questions resolved
- Self-hosting development strategy agreed

---

## Stage 1 — Port GateStack Pro WebGL framework

**Goal:** Schematic has a working Vite + TypeScript frontend that builds and boots a blank WebGL canvas, with GateStack Pro's rendering infrastructure copied in and all trading-specific code stripped.

**Unlocks:** Stage 2 (render a graph using this infrastructure).

**Dependencies:** None.

**Parallelizable with:** Stage 3 (daemon skeleton) can start in parallel if a second hand is available.

**Estimated effort:** 1–2 days of focused work.

### 1.1 — Set up monorepo skeleton

- Decide package manager: **pnpm workspaces** (recommended — widely supported, predictable, no migration story) or bun workspaces (faster but less mature).
- Create `package.json` at repo root declaring workspaces `["cli", "daemon", "frontend", "shared"]`.
- Create `tsconfig.base.json` with strict TypeScript settings; each workspace extends it.
- Add `.gitignore` entries for `node_modules/`, `dist/`, `.schematic/` (local state).
- Commit: *"Init monorepo skeleton with pnpm workspaces"*.

### 1.2 — Create `shared/` workspace

- `shared/package.json` with `main: "src/index.ts"`, no runtime deps.
- `shared/src/index.ts` re-exporting placeholder types.
- `shared/src/types/node-state.ts` — paste the `NodeState` + `Edge` interfaces from `BUILDING_PLAN.md §3`. These are our source of truth for data shape.
- Commit: *"Add shared types package with NodeState/Edge from spec"*.

### 1.3 — Create `frontend/` workspace skeleton

- `frontend/package.json` depending on `vite`, `typescript`, `@schematic/shared` (workspace link).
- `frontend/vite.config.ts` — copy from `~/GateStack-Pro/frontend/vite.config.ts`, change backend proxy URL from `:8002` to `:7777`, drop any Clerk/SaaS-specific vite plugins.
- `frontend/tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json` — copy from GateStack-Pro, keep generic parts, extend `tsconfig.base.json`.
- `frontend/index.html` — minimal, one `<div id="root">`.
- `frontend/src/main.ts` — empty entry that renders nothing yet.
- Install deps (`pnpm install`), run `pnpm dev`, confirm Vite dev server boots on some port.
- Commit: *"Add frontend workspace with Vite + TS"*.

### 1.4 — Strip trading dependencies

From the copied `package.json`, remove:
- `@clerk/clerk-react` (SaaS auth)
- `echarts` and `echarts-for-react`
- `lightweight-charts`
- Any Databento/Alpaca/Polygon client libs
- Any Python-side deps that snuck in

Keep: `react` (optional — we may write vanilla TS instead), `typescript`, `vite`, any plain math/geometry helpers.

Run `pnpm install` again. Verify dev server still boots.

Commit: *"Strip trading deps from frontend package.json"*.

### 1.5 — Port WebGL core files (direct copies)

Copy from `~/GateStack-Pro/frontend/src/components/chart/webgl/` to `~/Schematic/frontend/src/webgl/`:

- `viewport.ts` (143 lines) — pure geometry, **copy verbatim**.
- `renderer.ts` (394 lines) — WebGL 2 harness, **copy verbatim**; note it imports `VERTEX_SHADER`/`FRAGMENT_SHADER` from `shaders.ts` which we will rewrite.
- `interaction.ts` (83 lines) — crosshair + `pixelToData`, **copy verbatim**.
- `rangeLoader.ts` (108 lines) — viewport-relative data chunking. **Copy with a TODO**: later adapt bar-width logic to node-density logic.

Run typecheck (`pnpm -w tsc --noEmit`). Expect a few errors where `shaders.ts` no longer exists. Good — that's the seam.

Commit: *"Port WebGL core files from GateStack Pro (verbatim)"*.

### 1.6 — Rewrite `shaders.ts` for nodes + edges

Delete the copied `shaders.ts` (it's 31 lines of OHLC quad tessellation — not relevant).

Write a new `shaders.ts` with two shader pairs:
- **Node shader**: instanced rectangles. Vertex shader takes per-instance `(x, y, w, h, color, halo_color, halo_intensity)`; fragment shader draws a rounded rectangle with an outer halo.
- **Edge shader**: instanced line segments. Per-instance `(x0, y0, x1, y1, thickness, color, dashed)`; fragment shader does dash pattern if requested.

For Stage 1, keep the GLSL minimal — just colored rectangles and straight lines. Halo, rounding, dashes can land in Stage 2.

Commit: *"Rewrite shaders for node rectangles and edge lines"*.

### 1.7 — Port `overlayLayer.ts` (adapt)

Copy `overlayLayer.ts` (259 lines) from GateStack-Pro. Edit surgically:
- Keep: generic drawing primitives (text labels, shapes, lines, boxes).
- Strip: trading-specific concepts (`levels` as horizontal price lines, `entry lines` as time-range boxes, `indicators` as polylines).
- Replace with: label-renderer for node names, badge-renderer for error counts, tooltip surface.

Run typecheck. Fix imports.

Commit: *"Port and adapt overlayLayer for node-graph overlays"*.

### 1.8 — Port `axes.ts` (decide: adapt or defer)

`axes.ts` (178 lines) is time + price axes. Schematic has no axes in the traditional sense. Two options:

- **Option A:** delete `axes.ts` entirely. Graph coordinates need no axes.
- **Option B:** adapt for a mini-map / scale-indicator showing current zoom level.

**Recommendation: delete for Stage 1.** Revisit in Stage 12 polish if a scale indicator turns out useful.

Commit: *"Remove axes.ts — not needed for node-graph rendering"*.

### 1.9 — Smoke test: blank WebGL canvas

- Edit `frontend/src/main.ts` to instantiate a canvas, construct a `Renderer` from the ported code, pan/zoom with mouse events, render an empty scene.
- Run `pnpm dev`, open the page. Should see a dark canvas that responds to mouse wheel (zoom) and drag (pan) without errors.

Commit: *"Smoke test: blank WebGL canvas with pan/zoom"*.

### Gate criteria — Stage 1

- [ ] `pnpm install` and `pnpm -w tsc --noEmit` both succeed
- [ ] `pnpm --filter @schematic/frontend dev` boots a Vite server
- [ ] The served page shows a dark canvas
- [ ] Mouse wheel zooms; mouse drag pans; neither throws console errors
- [ ] No imports reference GateStack Pro files anywhere
- [ ] `package.json` has zero trading-specific dependencies
- [ ] Git history is a sequence of small, reviewable commits

### Self-hosting check — Stage 1

N/A — Schematic cannot yet index any repo, including itself. Self-hosting begins at Stage 6.

---

## Stage 2 — Render a hardcoded node graph

**Goal:** The canvas renders a small mock node graph (~10 nodes, ~15 edges) with pan/zoom/hover/click working. No daemon, no extraction — just proof that the ported WebGL can draw our data shape.

**Unlocks:** Stage 5 (hook wiring) and Stage 6 (real graph extraction) — both need something to render into.

**Dependencies:** Stage 1.

**Parallelizable with:** Stages 3–4 (daemon + CLI) if two hands available.

**Estimated effort:** 1–2 days.

### 2.1 — Mock graph data

Create `frontend/src/state/mock-graph.ts` with ~10 `NodeState` values and ~15 `Edge` values (hand-authored for variety: some files, one module, a couple of symbols). Use real-looking names (`parser.ts`, `renderer.ts`, `Engine`) for dogfood feel.

Assign `x, y, w, h` manually — this is a hand-laid graph for rendering validation, not a layout test.

### 2.2 — Node renderer

Create `frontend/src/graph/node-renderer.ts`. Given a list of `NodeState`, build an instanced buffer of `(x, y, w, h, color, halo_color, halo_intensity)` and hand to the WebGL `Renderer`. One draw call for all nodes.

Visual encoding for Stage 2 (minimal):
- Fill color = language-based palette (`ts` blue-ish, default grey)
- Halo = `ai_intent` (idle = none, modified = green, etc.)
- Border = `user_state === "selected"` → white; else none

### 2.3 — Edge renderer

Create `frontend/src/graph/edge-renderer.ts`. Given a list of `Edge` + the current node positions, build an instanced buffer for line segments. One draw call.

Edge style: solid grey for imports, dashed for type-only.

### 2.4 — Hit testing

Create `frontend/src/graph/hit-test.ts`. Given a mouse `(x, y)` in canvas space, use `viewport.pixelToData` to get graph space, iterate nodes (in reverse z-order so top layers hit first), return the node at the point or `null`.

For 10 nodes this is O(n). Later stages may need a quadtree; Stage 2 doesn't.

### 2.5 — Pan / zoom / hover / click

Wire mouse events on the canvas:
- Wheel → `viewport.zoom`
- Drag (mousedown + mousemove + mouseup) → `viewport.pan`
- Hover → call `hit-test`, update `nodeUnderCursor`, re-render
- Click → call `hit-test`, set `user_state = "selected"` on the hit node (deselect others)

Each event triggers a single re-render pass.

### 2.6 — Simple hover tooltip

In `overlayLayer.ts`, add a hover tooltip: when a node is hovered, draw a 2D Canvas rectangle near the cursor with the node's `name`, `path`, and `signature` (if symbol).

### 2.7 — Mock state animation

Add a keyboard shortcut (e.g., pressing `space`) that cycles the `ai_intent` of a random node: `idle → planning → modified → idle`. Validates the halo animation works.

### Gate criteria — Stage 2

- [ ] 10 nodes and ~15 edges visible on a dark canvas
- [ ] Panning and zooming feel smooth at 60fps
- [ ] Hover over a node → tooltip shows
- [ ] Click a node → it gets a selection border; clicking empty space deselects
- [ ] Pressing `space` cycles one node through `planning → modified → idle` with visible halo transitions
- [ ] 60fps maintained with a mock graph of 1,000 nodes (generated procedurally for stress test)

### Self-hosting check — Stage 2

N/A — still no extraction. But the mock graph should use realistic Schematic module names (`Engine`, `Rendering`, `Server`, etc.) as a spiritual self-host.

---

## Stage 3 — Daemon skeleton + workspace state machine

**Goal:** A `daemon` binary that binds to port 7777, accepts hook POSTs, accepts WebSocket connections, registers workspaces by `cwd`, persists `workspaces.json`, and can be started/stopped cleanly.

**Unlocks:** Stage 4 (CLI wraps daemon lifecycle), Stage 5 (hooks have a target to post to).

**Dependencies:** None — runs independently of frontend.

**Parallelizable with:** Stages 1–2 (frontend work).

**Estimated effort:** 2–3 days.

### 3.1 — `daemon/` workspace scaffolding

- `daemon/package.json` with deps: `ws` (WebSocket), type definitions, nothing exotic.
- `daemon/tsconfig.json` extending base, emitting CJS or ESM (pick one — recommend ESM for consistency with frontend).
- `daemon/src/index.ts` entry: parse port from `~/.schematic/config.json`, bind HTTP server, start WebSocket server on the same port via upgrade.

### 3.2 — HTTP layer

`daemon/src/http.ts` exposes:
- `POST /hook` — receives hook payloads, returns 200
- `GET /status` — returns daemon uptime, port, session count, events processed
- `GET /workspaces` — returns the workspaces registry
- `POST /workspaces/:id/activate` | `/pause` | `/resume` | `/disable` | `/forget`
- `POST /workspaces/:id/relayout`

For Stage 3, `POST /hook` just logs the payload. Routing to workspaces happens in 3.5.

### 3.3 — WebSocket layer

`daemon/src/ws.ts` exposes a WebSocket endpoint at `/ws`. Clients subscribe; daemon broadcasts events to subscribed clients. Supports subscription filters (by workspace, by event type).

Message format (from `shared/protocol/ws-messages.ts`):
```ts
type WSMessage =
  | { type: "subscribe", workspace_id?: string }
  | { type: "event", event: Event };
```

### 3.4 — Workspace registry

`daemon/src/workspaces/registry.ts`:
- Reads `~/.schematic/workspaces.json` on startup (creates if missing)
- Exposes `register(path)`, `activate(id)`, `pause(id)`, `disable(id)`, `forget(id)`, `get(id)`, `findByPath(cwd)`
- Persists atomically (write tmp, rename)

`daemon/src/workspaces/state-machine.ts` enforces legal transitions from §7 of BUILDING_PLAN.

### 3.5 — cwd-based routing

`daemon/src/workspaces/router.ts`: given a `cwd`, walk up the filesystem looking for `.git`, `.schematic.json`, `.schematic/`, or a path matching an existing workspace. Return the workspace ID or register a new one.

Used by `POST /hook` to tag every hook with `workspace_id`.

### 3.6 — Persistence layout

On daemon startup, ensure:
- `~/.schematic/` exists
- `~/.schematic/config.json` exists (default port, toast policy, ignored paths)
- `~/.schematic/workspaces.json` exists (empty array OK)
- `~/.schematic/workspaces/` exists

### 3.7 — Events emitter

`daemon/src/events/emitter.ts` — typed event bus. Events are broadcast to WebSocket clients and (future) persisted to `events.log`.

Stage 3 events: `workspace.registered`, `workspace.activated`, `workspace.paused`, `workspace.disabled`, `workspace.forgotten`.

### 3.8 — CLI-less smoke test

Add `daemon/src/bin.ts` that spawns the daemon directly (pre-CLI). Run `pnpm --filter @schematic/daemon start`. Confirm:
- Port 7777 binds (or fallback if taken)
- `curl http://localhost:7777/status` returns JSON
- `curl -X POST http://localhost:7777/hook -d '{"event":"PreToolUse","cwd":"/tmp/test","session_id":"abc"}'` returns 200, logs the payload, creates a workspace entry

### Gate criteria — Stage 3

- [ ] Daemon binds a port and stays running until SIGTERM
- [ ] `POST /hook` accepts payloads with `cwd`, routes to a workspace, logs event
- [ ] Hitting an unknown cwd creates a new workspace in `workspaces.json` with state `registered`
- [ ] `~/.schematic/workspaces.json` survives a daemon restart
- [ ] A WebSocket client can connect to `/ws` and receive broadcast events
- [ ] Graceful shutdown on SIGTERM — persists state, closes connections, exits

### Self-hosting check — Stage 3

N/A — no extraction yet.

---

## Stage 4 — Install CLI

**Goal:** The `schematic` CLI installs hooks + MCP into the user's global Claude Code settings, starts/stops the daemon, manages workspaces.

**Unlocks:** Stage 5 (users can actually run hooks). Everything beyond here assumes a working CLI.

**Dependencies:** Stage 3.

**Parallelizable with:** Stage 2.

**Estimated effort:** 1–2 days.

### 4.1 — `cli/` workspace scaffolding

- `cli/package.json` with `bin: { "schematic": "./dist/index.js" }`.
- `commander` (or similar) for argument parsing.
- `cli/src/index.ts` — argument dispatcher.

### 4.2 — `schematic start | stop | restart | status`

Start: check if daemon is already running (hit `/status`). If yes, exit 0 with message. If no, spawn `daemon/dist/index.js` detached; wait for `/status` to return; print success.

Stop: POST to a stop endpoint the daemon exposes, or send SIGTERM to the PID file.

Status: hit `/status`, pretty-print.

### 4.3 — `schematic install`

This is the critical step. Must be **idempotent** — running twice should leave the system in the same state.

Steps:
1. Read `~/.claude/settings.json` (create if missing, with minimal valid content).
2. Parse as JSON (fail loudly if invalid — user must fix).
3. Write/update MCP entry: `mcpServers.schematic = { command: "...", args: [...], transport: "stdio" }`.
4. Write/update hooks:
   - `PreToolUse` → shell script that POSTs to `localhost:<port>/hook`
   - `PostToolUse` → same
   - `UserPromptSubmit` → same, also fetches `<arch-context>` response from daemon and prepends to prompt
5. Create `~/.schematic/` if missing.
6. Pick port (default 7777, fallback if in use), write to `~/.schematic/config.json`.
7. Start daemon.
8. Print dashboard URL and next steps.

The settings-writer (`cli/src/utils/settings-writer.ts`) must preserve existing JSON structure — never stomp on user's other CC settings.

### 4.4 — `schematic uninstall`

Reverse of install:
1. Remove the `schematic` MCP entry and the three hook entries from `~/.claude/settings.json` (leave everything else).
2. Stop daemon.
3. Prompt user to keep or delete `~/.schematic/` (default: keep, preserves layouts for reinstall).

### 4.5 — `schematic workspaces list | info <id> | forget <id>`

Simple wrappers over the daemon's HTTP endpoints.

### 4.6 — `schematic activate | pause | resume | disable [path]`

Default `path` = `pwd`. CLI resolves path to workspace ID via daemon's router, issues the action.

### 4.7 — `schematic config get | set <key> [value]`

Read/write `~/.schematic/config.json`.

### 4.8 — `schematic log [--tail] [--workspace <id>]`

Tail or dump the event log from `~/.schematic/workspaces/<id>/events.log`.

### Gate criteria — Stage 4

- [ ] `pnpm --filter @schematic/cli build` produces a working binary
- [ ] `schematic install` writes hooks/MCP correctly to `~/.claude/settings.json` without corrupting other entries (test: an existing settings file with other MCP servers + hooks survives install)
- [ ] `schematic uninstall` fully reverses `install`
- [ ] All subcommands return non-zero on error with a helpful message
- [ ] Running `schematic install` twice is a no-op the second time

### Self-hosting check — Stage 4

Run `schematic install` on your own machine. Verify a CC session in `~/Schematic/` produces no hook errors (daemon logs a hook when you ask CC any question). The workspace should auto-register.

---

## Stage 5 — Hook wiring end-to-end

**Goal:** CC edits a file → node in the frontend flashes yellow → green, in real time. The whole event path works: CC → hook → daemon → WS → browser.

**Unlocks:** Every subsequent stage relies on this event flow.

**Dependencies:** Stages 2, 3, 4.

**Parallelizable with:** None meaningfully.

**Estimated effort:** 2 days.

### 5.1 — Finalize hook payload schema

In `shared/src/types/hook-payload.ts`, lock the hook payload format from BUILDING_PLAN §6:
```ts
interface HookPayload {
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit";
  tool: string | null;
  target: string | null;
  cwd: string;
  session_id: string;
  timestamp: number;
  success: boolean | null;
  prompt: string | null;
}
```

### 5.2 — Hook scripts

Each hook is a tiny shell script (or Node one-liner) that POSTs `$JSON` to `localhost:$PORT/hook`. Port is read from `~/.schematic/config.json` at hook-fire time (so port changes are picked up without reinstall).

Keep scripts < 20 lines. On POST failure, log a warning but do not fail the CC tool call.

### 5.3 — Daemon applies events to workspace state

`daemon/src/workspaces/state-apply.ts`: given a hook payload + a workspace, compute the node state delta:
- `PreToolUse(Edit|Write)` → target node: `ai_intent = "planning"`, `ai_intent_since = now`
- `PostToolUse(Edit|Write)` success → `ai_intent = "modified"`
- `PostToolUse(Edit|Write)` failure → `ai_intent = "failed"`
- `PostToolUse(Bash rm/mv)` → `ai_intent = "deleted"`

For Stage 5, the workspace doesn't have a real graph yet — but it can still track a map of `file_path → NodeState` derived from hook events alone. A node exists if a hook has targeted it. Graph extraction in Stage 6 replaces this bootstrap map.

### 5.4 — Frontend WebSocket client

`frontend/src/state/ws-client.ts`: connects to `ws://localhost:<port>/ws`, subscribes, applies incoming events to `graph-store`.

Reconnection with backoff if the daemon goes down.

### 5.5 — Frontend renders state changes

The existing node-renderer (Stage 2) reads from `graph-store`. When an event updates state, the store notifies subscribers, a re-render is queued. Node halos flash on state change, fade on decay.

### 5.6 — Self-decay

Daemon runs a periodic decay pass (every 30 seconds): for each node, if `ai_intent = "modified"` and `now - ai_intent_since > 5 minutes`, demote to `"idle"`. Broadcast the delta.

### 5.7 — End-to-end demo

- Install Schematic globally
- Open a CC session, ask CC to edit a specific file
- Watch the frontend (even with only a minimal bootstrap map) light up that file's node yellow → green → fade

### Gate criteria — Stage 5

- [ ] CC edits → browser shows the change within 200ms
- [ ] Three simultaneous CC edits render three distinct halos; `ai_intent_session` shows which session did what
- [ ] Frontend reconnects cleanly if the daemon restarts
- [ ] Decay fires; halos fade after 5 minutes of inactivity

### Self-hosting check — Stage 5

When you work on Schematic itself with CC, your edits appear on Schematic's own frontend (even with the bootstrap map — a real node per file touched). First taste of dogfood.

---

## Stage 6 — Full graph extraction + cache layer

**Goal:** A real graph — files, imports, symbols, call edges — is extracted from an activated workspace, cached to disk, incrementally updated on file changes, and rendered in the frontend. **Self-hosting fully online from this stage.**

**Unlocks:** Everything beyond. Stage 7 needs real nodes; Stage 8 needs a multi-tier graph; etc.

**Dependencies:** Stages 1–5.

**Parallelizable with:** None — this is the spine.

**Estimated effort:** 4–6 days.

### 6.1 — Directory walker

`daemon/src/extraction/walker.ts`: given a repo root, walks respecting `.gitignore`. Returns a list of `{path, mtime, byte_size, language}`.

### 6.2 — Module detection

`daemon/src/extraction/module-detect.ts`:
- Default: each directory becomes a module; top-level directories become top-level modules; depth mirrors filesystem depth
- If `.schematic.json` exists at repo root, parse its `modules` section, use glob matching to assign files to declared modules, override the default

### 6.3 — File-level import parser

`daemon/src/extraction/imports.ts`:
- Use `dependency-cruiser` or TS compiler API for TS/JS/TSX/JSX
- For each file, produce a list of outgoing `import` edges keyed by resolved target path
- Normalize paths to repo-relative form

### 6.4 — Symbol extractor

`daemon/src/extraction/symbols.ts`:
- TS compiler API with the project's tsconfig
- For each file, walk the AST, emit exported symbols (functions, classes, interfaces, types, constants)
- For each symbol: `signature`, `symbol_kind`, `parent` (= file ID), `depth` = file depth + 1

### 6.5 — Call-graph extractor

`daemon/src/extraction/call-graph.ts`:
- TS compiler API `getReferencedSymbols` / `findReferences` to build caller→callee edges between exported symbols
- Emit as `Edge` with `kind: "calls"`

### 6.6 — Mention index

`daemon/src/extraction/mention-index.ts`:
- Collect all identifiers: file paths, basenames, module names, symbol names
- Build Aho-Corasick automaton
- Serialize to `mention-index.bin` (use a library: `ahocorasick` or similar)

### 6.7 — Cache layer

`daemon/src/cache/graph-cache.ts`:
- `read(workspace_id): CachedGraph | null` — loads `graph.json`, verifies schema version
- `write(workspace_id, graph): void` — atomic write via `.tmp` + rename
- `invalidate(workspace_id, trigger)` — selective invalidation per the rules in BUILDING_PLAN §7
- `isDirty(path, cached_mtime)` — mtime + content-hash comparison

### 6.8 — Activation flow

Tie it all together in `daemon/src/workspaces/activate.ts`:
1. Try cache. If exists and config hashes match, skip full re-parse.
2. Walk filesystem, find dirty files, re-parse them.
3. Update graph, broadcast deltas.
4. If no cache or config changed: full parse, stream progress events.
5. Start health sources (Stage 11).

### 6.9 — fs watcher

`daemon/src/fs-watch/watcher.ts`:
- Per-workspace, watches via `chokidar` or native `fs.watch`
- On file change/add/delete: re-parse that file, update graph, broadcast
- Debounced to batch bursts (e.g., from a `git checkout`)

### 6.10 — Progress streaming

Stream `workspace.extraction_progress` events with phase + counts every ~500ms or 100 files.

### 6.11 — Frontend activation UX

- Browser shows the overlay from USER_SIMULATION Scene 3 during progress
- On `workspace.ready`, overlay fades, graph renders

### 6.12 — Auto-activation on marker

In `daemon/src/workspaces/router.ts`, when registering a new workspace, check for `.schematic.json` / `.schematic/`. If present → auto-transition to `active` immediately.

### 6.13 — Commit `.schematic.json` for self-hosting

Create `~/Schematic/.schematic.json` with:
```json
{
  "modules": {
    "CLI": { "paths": ["cli/**"] },
    "Daemon": { "paths": ["daemon/**"] },
    "Frontend": { "paths": ["frontend/**"] },
    "Shared": { "paths": ["shared/**"] }
  },
  "ignore": ["dist", "node_modules", ".schematic"]
}
```

Commit and push. From this moment forward, when you work on Schematic inside CC, Schematic auto-activates on itself.

### Gate criteria — Stage 6

- [ ] Activate Schematic's own repo — it indexes in under 60 seconds
- [ ] Graph shows 4 top-level modules (CLI, Daemon, Frontend, Shared) with files nested
- [ ] Save a file in `daemon/` — within 1 second the browser reflects the change
- [ ] Restart the daemon — re-activation is <2 seconds (cache hit)
- [ ] Change `tsconfig.base.json` — re-activation triggers full re-parse
- [ ] A second repo (GateStack-Pro) can be activated without breaking Schematic's workspace

### Self-hosting check — Stage 6

**This is the dogfood moment.** Schematic running Schematic. For every subsequent stage, validate by checking that Schematic's own map stays accurate and useful.

---

## Stage 7 — Manual layout

**Goal:** Users drag modules with their children, push-apart physics resolve overlap, positions persist, multi-select works, full re-layout is a user-triggered action.

**Unlocks:** Stage 8 (zoom tiers need stable layout).

**Dependencies:** Stages 2, 6.

**Parallelizable with:** None in the critical path.

**Estimated effort:** 3–4 days.

### 7.1 — Force-directed auto-layout

`frontend/src/graph/layout/force-directed.ts`:
- Use `d3-force` or hand-rolled force simulation
- Hierarchical bias: parents contain children (groups are soft boxes)
- Runs once at first activation, writes positions to `graph-store`

### 7.2 — Position persistence

Daemon exposes `POST /workspaces/:id/positions` — accepts a partial `{node_id, x, y, w, h}[]`. Writes to `positions.json` atomically, debounced ~500ms.

### 7.3 — Drag with children

`frontend/src/graph/layout/drag.ts`: on mousedown, compute the dragged node + all descendants. On mousemove, translate the whole subtree by `(dx, dy)` — single shader transform, one draw call. On mouseup, broadcast `user.node_moved` with the subtree's new positions.

### 7.4 — Push-apart physics

When a drag overlaps a non-dragged node, apply a force to displace it outward. Use d3-force with a custom collision-box constraint at a low iteration count for live responsiveness. On drop, run a settling pass.

### 7.5 — Module auto-fit bounds

Compute module bounds from children's bounding box + padding. Recompute on every child move. Render as outer rectangle with label at top-left corner.

### 7.6 — User-sized bounds override

Dragging a module's edge toggles `manually_sized = true`, disables auto-fit. Re-grab-and-drag-interior returns to auto-fit (small UI affordance).

### 7.7 — Multi-select

- Shift-drag on empty canvas → lasso rectangle, all nodes inside become `user_multi_selected = true`
- Ctrl/Cmd-click → toggle individual node membership
- Any drag on a multi-selected node → bulk drag preserving relative positions

### 7.8 — Full re-layout button

Top bar has a "Re-layout" button. Click → confirmation modal ("this will move all non-locked nodes"). Confirm → wipe `manually_positioned` across the workspace, re-run force-directed, broadcast.

### 7.9 — Incremental placement

When Stage 6's fs-watcher adds a new node (new file), place it near its nearest imported/importing neighbor. Push-apart resolves overlap. Existing manually-positioned nodes do not move.

### Gate criteria — Stage 7

- [ ] Drag Engine module → all 30+ children move as one; Prob Engine displaces smoothly
- [ ] Drop Engine → its position persists across daemon restart
- [ ] Create a new file in Schematic's own repo → new node appears placed near neighbors, existing positions intact
- [ ] Lasso-select 5 files → drag one → all 5 move together
- [ ] Re-layout button wipes manual placements, confirmation modal works

### Self-hosting check — Stage 7

Reorganize Schematic's own map — drag `Daemon` and `CLI` to visually adjacent. Save, restart, confirm layout preserved.

---

## Stage 8 — Zoom tiers + activity propagation

**Goal:** The graph renders at four zoom tiers (modules / +files / +symbols / +call-edges), cross-module edges aggregate at low zoom, and activity (AI intent, health) propagates up the hierarchy.

**Unlocks:** Stage 9 (tier-3 rendering).

**Dependencies:** Stages 6, 7.

**Parallelizable with:** None.

**Estimated effort:** 3–4 days.

### 8.1 — LOD culling

In the frontend, before drawing each node: check current camera zoom, compare against the node's tier-visibility threshold. Cull if out of tier. Apply per-frame.

### 8.2 — Zoom thresholds

Constants matching the table in BUILDING_PLAN §4: 0–10%, 10–40%, 40–80%, 80%+. Soft transitions with fade-in/out over a small zoom window.

### 8.3 — Aggregated cross-layer edges

Daemon pre-computes: for each pair of modules, count the file-to-file edges between them. Emit an aggregated `Edge` with `weight = count`, `kind = "aggregated"`.

Frontend: at tier 0, render aggregated edges only. As zoom increases, smoothly morph from aggregated to individual.

### 8.4 — Activity aggregation

Daemon rolls up `ai_intent` and `health`:
- Whenever a leaf node's state changes, walk up `parent`, compute `aggregated_ai_intent` and `aggregated_health` for each ancestor, broadcast deltas.
- Aggregated values use a simple policy: `aggregated_ai_intent = "active"` if any descendant is non-idle; `aggregated_health.errors = sum(descendant.health === "error")`.

### 8.5 — Visual encoding of aggregates

At tier 0, module rectangles show:
- Subtle glow if `aggregated_ai_intent = "active"`
- Small red badge with count if `aggregated_health.errors > 0`
- Dimmer glow if activity was recent but has decayed

### 8.6 — Smooth zoom transitions

When the user zooms across a threshold, animate node opacity and edge morphing over ~200ms to avoid flicker.

### Gate criteria — Stage 8

- [ ] Zoom from 100% to 5% on Schematic's own map → 4 modules visible at the end, transitions smooth
- [ ] Edit a file deep in `daemon/` — at every zoom level, activity is visible at appropriate depth
- [ ] Module-to-module edges are visible at tier 0 with thickness corresponding to underlying connection count
- [ ] Zoom into Daemon → aggregated edges dissolve into individual file-level ones

### Self-hosting check — Stage 8

Zoom out on Schematic. Should see exactly 4 modules (CLI, Daemon, Frontend, Shared) with the edges between them reflecting real dependencies (Frontend imports from Shared, Daemon imports from Shared, both minimal overlap). Any surprise edges reveal real architectural coupling worth investigating.

---

## Stage 9 — Tier-3 symbol rendering

**Goal:** Zooming past 80% reveals individual symbols (functions, classes, types) inside files, with call edges between them. Data is already in the cache from Stage 6 — this stage is rendering only.

**Unlocks:** Stage 10 (symbol-level MCP queries).

**Dependencies:** Stages 6, 8.

**Estimated effort:** 2–3 days.

### 9.1 — Symbol node rendering

Symbol nodes are small rectangles (or rounded pills) arranged inside their parent file's bounds. Use a compact vertical stack with signature as label.

### 9.2 — Call edges

Render call edges as thin lines between symbols. At tier 2, aggregated to file-level; at tier 3, individual.

### 9.3 — Symbol interactions

Hover a symbol → tooltip shows `signature`. Click → select, diagnostics sidebar updates (if tier-3 diagnostics exist).

### 9.4 — Symbol-level hit testing

Extend the hit-test to symbols when at tier 3 zoom.

### 9.5 — Symbol search

Add a search input (floating over the canvas). Typing `extractFeatures` shows autocomplete matching symbols, click → camera zooms to and selects that symbol.

### Gate criteria — Stage 9

- [ ] Zoom into `daemon/src/extraction/symbols.ts` → individual functions and classes visible
- [ ] Call edges show `extractSymbols()` calling `walkAst()` (or whatever the actual structure is)
- [ ] Search for a known symbol name → camera jumps to it
- [ ] 60fps maintained at tier 3 on Schematic's own codebase

### Self-hosting check — Stage 9

Navigate to a specific function in Schematic. Click it. Verify it's correctly identified, signature matches source, call edges match actual callers.

---

## Stage 10 — CC context integration (MCP + arch-context)

**Goal:** Claude Code can query the graph via MCP tools, and every user prompt is augmented with `<arch-context>` containing current focus + diagnostics + recent mentions.

**Unlocks:** The core value proposition of Schematic — CC becomes graph-aware.

**Dependencies:** Stages 5, 6, 7 (arguably 8 for richer context).

**Estimated effort:** 3–4 days.

### 10.1 — MCP server

`daemon/src/mcp.ts`:
- Stdio transport as a child process of CC (per MCP spec)
- Tools: `arch_neighbors`, `arch_impact`, `arch_find`, `arch_get_selection`, `arch_health` (stub for now, wired fully in Stage 11)

### 10.2 — MCP tool implementations

Each tool resolves against the currently-active workspace (inferred from the cwd the MCP process was spawned with, or the most-recently-active workspace).

### 10.3 — arch-context builder

`daemon/src/context/builder.ts`: given a workspace, construct the `<arch-context>` block:
- Currently-selected node(s)
- Recently-mentioned nodes (via Aho-Corasick on the latest prompt)
- Diagnostics for any focused node (if error/warning)
- Limit to ~500 tokens — don't flood CC's prompt

### 10.4 — UserPromptSubmit hook injection

The `UserPromptSubmit` hook script fetches `<arch-context>` from `GET /hook/context?cwd=...` and prepends to the prompt before it reaches CC. If the fetch fails, the prompt passes through unchanged.

### 10.5 — Two-sided mention extraction

In the hook handler, run Aho-Corasick on:
- `prompt` field (user-side mentions)
- `target` / tool-input fields (CC-side mentions)

Update `last_mention_ts` on matched nodes.

### 10.6 — Mention glow

Frontend: subtle yellow-white halo, opacity = `f(now - last_mention_ts)`, fades over ~10 minutes.

### 10.7 — Register MCP in `schematic install`

Update the Stage 4 installer to include the MCP server entry.

### Gate criteria — Stage 10

- [ ] Ask CC "what does parser.ts import?" — CC uses `arch_neighbors` and answers accurately
- [ ] Click parser.ts in the map, type "fix it" in CC → CC sees the file name in `<arch-context>` and picks up the context
- [ ] Mention glow appears on mentioned nodes in real time
- [ ] `<arch-context>` stays under 500 tokens

### Self-hosting check — Stage 10

Use Schematic on Schematic. Click a daemon file, ask CC to refactor it. Confirm CC receives the context and responds accordingly.

---

## Stage 11 — Health integration

**Goal:** `tsc --watch` and eslint run against every active workspace; diagnostics appear as node colors, the diagnostics side panel, and in `<arch-context>`.

**Unlocks:** The "map is a live cockpit" killer feature.

**Dependencies:** Stages 6, 10.

**Estimated effort:** 4–5 days.

### 11.1 — HealthSource interface

`daemon/src/health/source.ts`:
```ts
interface HealthSource {
  start(workspace: Workspace): Promise<void>;
  stop(): Promise<void>;
  onDiagnostics(cb: (diagnostics: Diagnostic[]) => void): void;
}
```

### 11.2 — tsc-watch runner

Spawn `tsc --watch --noEmit` (or `tsc -b -w`) with JSON diagnostic output. Parse stream, emit `Diagnostic[]`. Auto-restart on crash (exponential backoff).

### 11.3 — eslint runner

`eslint --watch` or custom loop with file-watcher. Parse JSON output.

### 11.4 — Generic command runner

`daemon/src/health/generic-runner.ts`: spawns an arbitrary shell command, pipes output through a named parser (pytest-json, mypy-json, etc.).

### 11.5 — Built-in parsers

`tsc-json.ts`, `eslint-json.ts`, `pytest-json.ts`, `mypy-json.ts` — each maps tool output to `Diagnostic`.

### 11.6 — Diagnostic → node mapping

`daemon/src/health/mapping.ts`: normalize diagnostic paths to repo-relative, look up node by path or (path + line range) for symbol-level.

### 11.7 — Aggregation

Health rolls up the tree. Module-level aggregate is `{ ok: N, warning: M, error: K }`.

### 11.8 — Staleness watchdog

Per source, if no diagnostic arrives for >30 seconds after a file change, mark affected nodes `health = "unknown"`.

### 11.9 — Diagnostics side panel

Right sidebar in frontend: when a node with errors is selected, shows full diagnostic messages with source attribution.

### 11.10 — `arch_health` MCP tool

Returns current diagnostics for a node as structured JSON. Used by CC before suggesting fixes.

### 11.11 — arch-context extension

When a user has a broken node focused, extend `<arch-context>` with diagnostic summaries.

### 11.12 — `.schematic.json` source config

Users declare sources per workspace. Validation at source-start — bad config fails loudly.

### Gate criteria — Stage 11

- [ ] Intentionally introduce a type error in Schematic's code — within ~3 seconds, the affected node shows a red dashed outline
- [ ] Fix the error — within ~3 seconds, red clears
- [ ] tsc crash — restarts automatically; nodes transition to `"unknown"` during the gap
- [ ] CC can read diagnostics via `arch_health` and uses them in its next suggestion

### Self-hosting check — Stage 11

Intentionally break Schematic itself. Watch the red propagate through modules. Ask CC to fix — verify CC sees the diagnostics via `<arch-context>`.

---

## Stage 12 — UX polish

**Goal:** The full user-facing surface from USER_SIMULATION.md — status pills, sidebars, drawer, overlays, settings.

**Unlocks:** A shippable product.

**Dependencies:** Stages 5, 6, 7, 10, 11.

**Estimated effort:** 5–7 days, spread over gates.

### 12.1 — Three-pill top bar

Implement daemon / CC activity / workspace pills with hover tooltips per BUILDING_PLAN §10.2.

### 12.2 — Left sidebar: workspaces

List view with state indicator, recent activity timestamp, health summary. Click → switch view. Right-click → context menu (activate/pause/resume/disable/re-index/forget).

### 12.3 — Right sidebar: diagnostics

Already partially built in Stage 11; polish formatting, grouping, keyboard nav.

### 12.4 — Bottom drawer: event feed

Toggled with backtick. Streams events with filtering (by workspace, session, event type). Retention capped at 10,000 in memory, rotating to `events.log`.

### 12.5 — Welcome overlay

First-visit overlay per BUILDING_PLAN §10.5. Dismissed state persists.

### 12.6 — Toast system

Policy engine driven by `~/.schematic/config.json`: first-time / once-per-day / silent / always. Per-path skip.

### 12.7 — Settings panel

Gear icon → form for port, toast cadence, event retention, theme, ignored paths, debug log level. Persist to config.

### 12.8 — Keyboard navigation

- `/` → focus search
- `` ` `` → toggle event drawer
- `Esc` → clear selection / close modals
- Arrow keys → pan
- `+` / `-` → zoom
- `[` / `]` → cycle workspaces

### 12.9 — Decay tuning

Tune `ai_intent` fade timing, mention-glow half-life, edge-highlight decay against real usage. Config constants in `frontend/src/constants.ts`.

### 12.10 — Edge cases

- Empty repo (no files) → clear empty-state message
- Binary files in tree (images, etc.) → ignore in graph
- Submodules → treat as external modules unless user opts in
- Symlinks → follow once, detect cycles

### Gate criteria — Stage 12

- [ ] A new user can install Schematic, follow the welcome overlay, activate a repo, find the diagnostics panel, and understand the three-pill status without external instruction
- [ ] All keyboard shortcuts work
- [ ] Settings persist across daemon restarts
- [ ] Event feed drawer performs well with 10k events

### Self-hosting check — Stage 12

Use Schematic as your only entry point to navigate Schematic's own codebase for a full day. Things you find yourself wanting that don't exist → issues or Stage 13.

---

## Stage 13 — Distribution (optional)

**Goal:** Package Schematic for distribution to other developers.

**Dependencies:** Stage 12.

### 13.1 — Chrome extension wrapper

Publishes `localhost:7777` as an always-on-top popup. Uses `chrome.windows.create({type:'popup', alwaysOnTop:true})`.

### 13.2 — LaunchAgent auto-start

macOS `~/Library/LaunchAgents/com.schematic.daemon.plist` spawns the daemon on login. Wrap in `schematic autostart enable | disable`.

### 13.3 — Installer polish

Published as a proper npm package with versioning, changelog, postinstall hints.

### 13.4 — Docs

A proper README, quickstart, FAQ. Website? Only if distributing broadly.

### Gate criteria — Stage 13

- [ ] Someone other than David can install Schematic in <5 minutes and see their own repo visualized

---

## Post-ship backlog (v1.5 / v2)

- Visual groups (lasso → labeled cluster, persisted)
- Cross-repo edges
- Drift-metric suggest-relayout notification
- Gentle background layout optimization
- Multi-user shared layouts
- Embedded chat panel via Claude Agent SDK
- Editor jump integration
- Python / Rust / Go first-class parsers
- Tiered-readiness threshold tuning for 10k+ repos

---

## Global reminders

- **Small commits.** Each sub-step ends with a reviewable commit. Not batched.
- **Surgery model.** Diff reviewed before applying. Especially Stage 1 where we are porting living code.
- **Dogfood.** From Stage 6, if Schematic can't usefully visualize itself, don't move on.
- **No backward-compat shims.** This is v1. If it breaks, we change it. No deprecation paths yet.
- **Respect the invariants.** All nine from BUILDING_PLAN §15. Especially #1 (CC never has to remember), #6 (user positions are sacred), #9 (visibility).
