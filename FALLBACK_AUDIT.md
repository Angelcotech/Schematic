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

_(future stages appended here)_
