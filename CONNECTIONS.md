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
- **Inputs:** browser (canvas element via DOM, mouse events)
- **Outputs:** calls `render` on RAF
- **Dependencies:** `webgl/renderer.ts`, `webgl/viewport.ts`, `webgl/overlayLayer.ts`
- **Consumers:** browser loads via `index.html`

---

## Cross-boundary connections

_(empty — populated as boundaries are defined)_

### CC ↔ Daemon
_(to be recorded in Stage 3)_

### Daemon ↔ Browser
_(to be recorded in Stage 3)_

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
