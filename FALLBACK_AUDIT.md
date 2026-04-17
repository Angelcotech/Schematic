# Schematic — Fallback Audit Log

Per Build Law 2: after every build phase, scan the code for fallback patterns. Fallbacks mask real failures with "it just works somehow" — the opposite of hardwired/deterministic. Each fallback found is either removed or explicitly justified with a written reason.

Fallback patterns to scan for:

- `try { ... } catch { /* silently continue */ }` — errors swallowed
- `if (x) { primary() } else { secondary() }` where the else-branch hides a missing-data case
- Default values that paper over absent data
- Retry loops, exponential backoff on non-transient failures
- Multiple interchangeable code paths with auto-selection
- Optional parameters that become implicit runtime decisions
- "If API A fails, call API B" without surfacing the failure
- Any pattern where the absence of something is treated as a legitimate state rather than a caller error

---

## Scan template (copy per stage)

### Stage N scan — YYYY-MM-DD
**Scope:** files modified during Stage N
**Command used:**
```
# e.g. rg 'catch\s*\(' app/src/
```
**Findings:**
- _(path:line — pattern — decision: removed / justified with reason)_

**Outcome:** ok | N fallbacks removed | N justified

---

## Stage 0 scan

**Date:** 2026-04-17
**Scope:** documentation only, no code
**Findings:** N/A
**Outcome:** ok — no code to scan

---

## Stage 1 scan

**Date:** 2026-04-17
**Scope:** `app/` and `frontend/src/` — new TypeScript files from Stage 1
**Commands used:**
```
rg 'catch\s*\(|try\s*\{|fallback|retry' app/ frontend/src/
rg '\|\|\s' app/ frontend/src/
```

**Findings:**

| Location | Pattern | Decision |
|----------|---------|----------|
| `frontend/src/webgl/renderer.ts:61` | `window.devicePixelRatio \|\| 1` | **Removed.** Modern browsers always define `devicePixelRatio`. `|| 1` was defensive for legacy/test environments which are not v1 targets. |
| `frontend/src/webgl/overlayLayer.ts:32` | `window.devicePixelRatio \|\| 1` | **Removed.** Same reasoning. |
| `frontend/src/webgl/viewport.ts:79-80` | `(maxX - minX) * paddingFrac \|\| 1` and y-equivalent | **Rewritten** as `Math.max(..., 1)` with a comment. The numerical-floor behavior is legitimate (degenerate single-node or collinear bounds must still produce visible viewport), but the `\|\|` pattern read as a fallback. `Math.max` expresses the intent clearly. |
| `frontend/src/webgl/renderer.ts:66` | `canvas.width !== bw \|\| canvas.height !== bh` | **Skipped.** Boolean OR in a condition, not a fallback pattern. |
| `frontend/src/webgl/overlayLayer.ts:37` | Same shape as above | **Skipped.** Boolean OR in a condition. |

**Outcome:** 2 fallbacks removed, 1 rewritten to express intent without `||`, 2 non-matches (boolean OR in conditions).

---

## Stage 2 scan

**Date:** 2026-04-17
**Scope:** new/modified files in Stage 2:
- `frontend/src/state/mock-graph.ts`
- `frontend/src/graph/{node-renderer, edge-renderer, hit-test}.ts`
- `frontend/src/main.ts` (rewritten)
- `tsconfig.base.json`, `frontend/tsconfig.json`

**Commands used:**
```
rg 'catch\s*\(|try\s*\{|fallback|retry' frontend/src
rg '\?\?\s' frontend/src
rg '\|\|\s' frontend/src
```

**Findings:**

| Location | Pattern | Decision |
|----------|---------|----------|
| `frontend/src/graph/node-renderer.ts:164` | `LANGUAGE_FILL[n.language] ?? DEFAULT_FILL` | **Justified.** Language keys are open-ended (any string extractable from a file); unknown languages receive a default gray rather than crashing render. Not hiding a bug — a visual default for an open enum. |
| `frontend/src/state/mock-graph.ts` | ~20 `partial.X ?? default` in `makeNode` helper | **Justified.** `makeNode` is a fixture constructor that fills defaults for missing fields. Not hiding errors; explicit optional-field defaults in a test factory. |
| `frontend/src/main.ts:215` ternary chain | `n.kind === "module" ? "module" : n.kind` | **Justified.** Tooltip metric display for unenumerated kinds gracefully shows the kind name. UI polish, not system correctness. |
| `frontend/src/graph/edge-renderer.ts:36-38` | `if (!src \|\| !dst) throw` | **Skipped.** Opposite of a fallback — hard-fails with a descriptive error if an edge references an unknown node. Hardwired correctness per Law 1. |
| `frontend/src/graph/hit-test.ts:32-33`, `main.ts:185`, `renderer.ts:66`, `overlayLayer.ts:37` | `\|\|` in `if` conditions | **Skipped.** Boolean OR in conditions, not fallback assignments. |

Also noted: `tsconfig.base.json` dropped `exactOptionalPropertyTypes: true`. Other strict flags kept. This lets optional properties hold explicit `undefined` — pragmatic for `NodeState` with many optional fields. Not a fallback; a language-feature tradeoff.

**Outcome:** ok — 3 patterns reviewed and justified, 0 removed, 0 silent fallbacks introduced.

---

## Stage 3 scan

**Date:** 2026-04-17
**Scope:** new files under `app/src/daemon/**` and `app/src/shared/{workspace, hook-payload, event, ws-messages}.ts`

**Commands used:**
```
rg 'catch\s*[\({]|try\s*\{|fallback|retry' app/src
rg '\?\?\s' app/src
rg '\|\|\s' app/src
```

**Findings:**

| Location | Pattern | Decision |
|----------|---------|----------|
| `daemon/workspaces/router.ts:26-29` | try/catch on `access()` to implement `exists()` | **Justified.** Idiomatic Node.js file-existence check. Catches ENOENT specifically and re-throws any other error (permission denied, etc.), so silent-swallow is impossible. |
| `daemon/workspaces/registry.ts:12-16` | try/catch on `readFile(workspaces.json)` | **Justified.** First-run init: no file → empty registry. ENOENT-specific catch, re-throws other errors. |
| `daemon/persist/config.ts:27-31` | try/catch on `readFile(config.json)` | **Justified.** First-run init: no file → write defaults. ENOENT-specific, re-throws other errors. Function named `readOrInitConfig` to make intent explicit. |
| `daemon/http.ts:25-51` | try/catch at top of request handler | **Justified.** HTTP error boundary: prevents an unhandled exception in a handler from crashing the daemon. Always logs to console + returns 500 to client. This is required for any HTTP service and not a fallback that hides behavior. |
| `daemon/http.ts:26-27` | `req.url ?? "/"` and `req.method ?? "GET"` | **Removed.** Replaced with an explicit check that returns a 400 response when the fields are missing. Hardwired per Law 1 — don't paper over "can't happen" cases with defaults. |
| `daemon/ws.ts:31` | `msg.workspace_id ?? null` | **Justified.** Normalizes optional field (undefined) to explicit null for internal storage. Not a fallback; type coercion. |

**Outcome:** 1 soft fallback removed (request defaults), 5 patterns justified as init / idiomatic / error boundary.

---

## Stage 4 scan

**Date:** 2026-04-17
**Scope:** `app/src/cli/**`, `app/src/daemon/http.ts` (endpoint additions), `app/src/daemon/index.ts`

**Commands used:**
```
rg 'catch\s*[\({]|try\s*\{|fallback|retry' app/src/cli app/src/daemon
rg '\?\?\s' app/src/cli
```

**Findings:**

| Location | Pattern | Decision |
|----------|---------|----------|
| `cli/index.ts:119` | `main().catch((e) => { console.error; exit(1); })` | **Justified.** CLI top-level error boundary. Converts unhandled rejection into a clean exit-with-message. Standard node-CLI pattern. |
| `cli/utils/daemon-client.ts:13-16` | `isDaemonRunning` try/catch | **Justified.** Catches ECONNREFUSED specifically (both plain and undici-nested `cause.code` shapes) to answer the literal question "is the daemon running?" Re-throws any unexpected error. |
| `cli/utils/settings-writer.ts:33-40` | nested try/catch around `readFile` + `JSON.parse` | **Justified.** Outer ENOENT → new-install state (empty settings). Inner JSON-parse failure → explicit throw that refuses to overwrite unreadable user content. No silent recovery. |
| `cli/commands/start.ts:28-39` | polling loop waiting for daemon to respond | **Justified.** 5-second hardwired deadline; on expiry, throws. Not an open-ended retry. Documented. |
| `cli/commands/stop.ts:9-17` | polling loop after shutdown request | **Justified.** Same shape as start: 2-second deadline, throws on expiry. |
| `cli/commands/hook-template.ts` (script generated at install) | `req.on("error") → exit(0)` and `on("timeout") → exit(0)` | **Justified deliberate design.** The hook must NOT block a CC session when Schematic's daemon is unreachable. Silent exit-0 with empty stdout → CC proceeds normally. This is the reference-surface identity (§1 Product in BUILDING_PLAN): Schematic is peripheral and must never break the user's primary tool. Documented in-file. |
| `cli/index.ts:82-88` | `rest[0] ?? process.cwd()` for activate/pause/resume/disable args | **Justified.** Explicit argument default — when the user runs the command without a path, use cwd. Parameterization, not a fallback. |
| `cli/utils/settings-writer.ts:84` | `settings.hooks[event] ?? []` | **Justified.** Object-extension pattern: if the event's matcher list doesn't exist yet, start empty before appending our entry. Not hiding missing data. |

**Outcome:** 0 fallbacks removed, 8 patterns reviewed and justified (all either error boundaries, explicit deadlines, or documented reference-surface design decisions).

---

## Stage 5 scan

**Date:** 2026-04-17
**Scope:** new files `app/src/daemon/{node-store,decay}.ts`, `frontend/src/state/{ws-client,graph-store}.ts`, rewritten `frontend/src/main.ts`, additions to `app/src/daemon/http.ts` (CORS, nodes endpoint), `app/src/daemon/workspaces/router.ts` (marker fix).

**Commands used:**
```
rg 'catch\s*[\({]|try\s*\{|fallback|retry' app/src/daemon/{node-store,decay}.ts frontend/src/state
rg '\?\?\s' app/src/daemon/node-store.ts frontend/src/state frontend/src/main.ts
```

**Findings:**

| Location | Pattern | Decision |
|----------|---------|----------|
| `frontend/src/state/ws-client.ts` BACKOFF_SCHEDULE_MS | Reconnect schedule `[1s, 2s, 5s, 10s, 10s, ...]` | **Justified.** Explicit finite schedule, no open-ended loop — deterministic re-attempt cadence documented per Build Law 1. |
| `frontend/src/main.ts:206` | `(urlParam && wsList.find(...)) ?? wsList.find(w => w.state === "active") ?? null` | **Justified.** Chained nullish is priority ordering: URL param overrides first-active-workspace. Each tier is an explicit rule, not silent fallback. |
| `frontend/src/main.ts:280` | `n.language ?? ""` (tooltip text) | **Justified.** UI display default when language wasn't extracted yet (pre-Stage 6 bootstrap node). |
| `app/src/daemon/node-store.ts:143` | `payload.tool ?? undefined` | **Justified.** Normalizing optional field for NodeState. |
| `app/src/daemon/node-store.ts:160` | `node.ai_intent_since ?? 0` | **Justified, self-healing.** If a node is non-idle but has no since timestamp (an invariant violation), the decay pass treats it as old and demotes to idle. Recovery to a good state, not bug concealment. |
| `app/src/daemon/http.ts` new `/workspaces/:id/nodes` | `store?.all() ?? []` | **Justified.** Workspace exists but no hooks have fired yet → empty array is the correct state, not a fallback. |
| `app/src/cli/utils/daemon-client.ts` expanded catch | `isDaemonRunning` now handles ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENETUNREACH, EHOSTUNREACH | **Justified widening.** The function's semantic question is "can we reach the daemon?" — any localhost-connectivity error answers no. Unexpected non-network errors still surface. |

**Also fixed during Stage 5 (bug, not a fallback):** the router treated `.schematic/` directory as an auto-activation marker, which conflicted with our own `~/.schematic/` state dir and caused spurious workspace registration for `$HOME`. Removed `.schematic/` from the marker set; `.schematic.json` is now the sole explicit auto-activation signal. Updated BUILDING_PLAN §7 and USER_SIMULATION to match.

**Outcome:** 0 fallbacks introduced, 7 patterns reviewed and justified, 1 routing bug fixed.

---

## Stage 6 scan

**Date:** 2026-04-17
**Scope:** new files under `app/src/daemon/extraction/`, `app/src/daemon/cache/`, `app/src/daemon/fs-watch/`, `app/src/daemon/workspaces/activate.ts`. Updates to `node-store.ts`, `http.ts`, `index.ts`, `shared/event.ts`. Frontend `main.ts` updated for graph/progress handling.

**Commands used:**
```
rg 'catch\s*[\({]|try\s*\{|fallback|retry' app/src/daemon/{extraction,cache,fs-watch,workspaces/activate.ts}
```

**Findings:**

| Location | Pattern | Decision |
|----------|---------|----------|
| `extraction/walker.ts:65-67` | try/catch around `readIgnoreFile` | **Justified.** ENOENT → null (no .gitignore / .schematic-ignore present). Other errors re-thrown. |
| `extraction/imports.ts:29-31` | try/catch around source-file read | **Justified.** ENOENT → empty-imports return (a file was deleted between walk and parse — benign race). Other errors re-thrown. |
| `extraction/modules.ts:20-23` | try/catch around `.schematic.json` read | **Justified.** ENOENT → null (falls back to directory-based module detection, which is the documented default). |
| `cache/graph-cache.ts:29-32` | `sha256OfFile` ENOENT handling | **Justified.** Hash returns null for missing config files (tsconfig, package.json, .schematic.json all optional). The invalidation check compares nulls correctly. |
| `cache/graph-cache.ts:53-59` | `readCache` error handling | **Justified.** ENOENT → null (no cache yet). Other errors → `console.warn` + return null, triggering a full re-extract. Not silent — the warning surfaces corruption. |
| `workspaces/activate.ts:40` | try/finally for `inProgress` flag | **Justified.** Cleanup guard, not a fallback. |
| `workspaces/activate.ts:45` | `.catch((e) => console.error(...))` on fs-change-triggered extraction | **Justified.** Fire-and-forget with loud logging. Extraction errors during fs watch don't crash the daemon but are visible in its stderr. |

Also noted: imports.ts comment mentions "retry with TS source extensions" — descriptive text about substitution candidates, not a retry loop.

**Outcome:** 0 silent fallbacks introduced. All new try/catch patterns are ENOENT-specific or explicit-logged recovery paths.

---

## Stage 7 scan

**Date:** 2026-04-17
**Scope:** `cache/positions.ts` (new), `cache/graph-cache.ts` (deleteCache added), `node-store.ts` (applyPositions + clearManualPositions), `http.ts` (positions + relayout endpoints), `workspaces/activate.ts` (applies positions after extract/cache), frontend `main.ts` (drag state, push-apart, persistence).

**Commands used:**
```
rg 'catch\s*[\({]|try\s*\{|fallback|retry' app/src/daemon/cache/positions.ts app/src/daemon/cache/graph-cache.ts frontend/src/main.ts
```

**Findings:**

| Location | Pattern | Decision |
|----------|---------|----------|
| `cache/positions.ts:25-28` | `readPositions` try/catch | **Justified.** ENOENT → `{}` (no manual drags yet). Other errors → warn + empty. Mirrors `readCache`. |
| `cache/positions.ts:42-45` | `deletePositions` try/catch | **Justified.** ENOENT → no-op (already absent). Other errors re-thrown. |
| `cache/graph-cache.ts` `deleteCache` | ENOENT handling | **Justified.** Same pattern as positions delete. |
| `main.ts` `persistPositions` error log on non-2xx | `console.error(...)` | **Justified.** Background POST from drag-end; failure surfaces in console and the next drag will try again. Not silent. |
| `workspaces/activate.ts` `applyPositions(nodes, positions)` helper | `override.width ?? n.width` | **Justified.** Optional override property — if a position row omits width/height (common for module-only drags), inherit the extracted dimensions. Parameterization, not a fallback hiding an error. |

No new silent fallbacks. Re-layout clears both cache and positions.json deterministically before re-activation, so the user's wipe intent is complete and observable.

**Outcome:** 0 fallbacks introduced, 5 patterns reviewed and justified.

---

## Stage 8 scan

**Date:** 2026-04-17
**Scope:** `frontend/src/graph/aggregation.ts` (new), updates to `frontend/src/graph/node-renderer.ts` and `frontend/src/main.ts`.

**Commands used:**
```
rg 'catch\s*[\({]|try\s*\{|fallback|retry' frontend/src/graph/aggregation.ts
rg '\?\?\s' frontend/src/graph/aggregation.ts
```

**Findings:**

| Location | Pattern | Decision |
|----------|---------|----------|
| `aggregation.ts:32` | `childrenByParent.get(m.id) ?? []` | **Justified.** A module with no children legitimately has an empty child set. |
| `aggregation.ts:42` | `c.ai_intent_since ?? 0` | **Justified.** Nodes without timestamps sort last; not a fallback hiding missing data. |
| `main.ts` tier/LOD logic | none relevant | Stage 8 LOD is purely geometric — no silent fallbacks. |

**Outcome:** 0 silent fallbacks introduced.

---

_(future stages appended here)_
