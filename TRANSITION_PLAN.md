# Schematic — Transition Plan

**From:** directory-render map (Stages 1–14 of BUILDING_PLAN.md)
**To:** CC-authored drafting canvas

## The one thing Schematic does

> The user tells Claude Code to draw a schematic of the repo — or a specific
> pipeline inside it. CC draws it. The canvas stays live as CC works.

Everything in this plan serves that sentence. Anything not in service of
that sentence is not in this plan.

---

## Why the reframe

1. Repos are organized for file lookup, not architecture. Auto-rendering the
   directory produces a map of file organization, not a map of architecture.
2. CC edits files by path; the canvas doesn't have to be 1-to-1 with the
   filesystem. One file can appear as multiple boxes; CC still knows which
   file on disk each box means.
3. The original motivation was a hand-authored ARCHITECTURE.md (mermaid).
   Schematic is now the tool that **writes and live-maintains that diagram**.

---

## Data shape (locked)

```ts
Canvas {
  id: string
  workspace_id: string
  name: string
  description?: string
  created_at: number
  updated_at: number
}

CanvasNode {
  id: string                 // unique within canvas
  canvas_id: string
  file_path: string          // workspace-relative; can repeat across nodes
  x: number                  // top-left in canvas data coords
  y: number
  width: number
  height: number
  process?: string           // at most one process label per node
}

CanvasEdge {
  id: string
  canvas_id: string
  src: string                // CanvasNode.id
  dst: string                // CanvasNode.id
  label?: string             // free text, e.g. "loads buffers"
  kind?: "calls" | "imports" | "reads" | "writes" | "control"
}
```

Rules:
- **One process per node.** If the same file belongs in two processes, put
  two boxes on the canvas pointing at that file.
- **Edges carry relationships**, not processes. Label + kind communicate
  what the wire means.
- **Canvas belongs to exactly one workspace.**

---

## Stages

Four stages. Each is a coherent commit. The old directory-render pathway
keeps working through Stage 17, then is deleted in Stage 17.

### Stage 15 — Canvas data model + HTTP endpoints

**Scope:**
- Types (above).
- Persistence: `~/.schematic/workspaces/<wid>/canvases/<cid>.json`, one file per canvas, atomic write.
- Endpoints:
  - `GET /workspaces/:wid/canvases`
  - `POST /workspaces/:wid/canvases` → body `{name, description?}` → creates blank canvas.
  - `GET /workspaces/:wid/canvases/:cid` → canvas + nodes + edges.
  - `PATCH /workspaces/:wid/canvases/:cid` → rename/describe.
  - `DELETE /workspaces/:wid/canvases/:cid`.
  - `POST /canvases/:cid/nodes`, `PATCH .../nodes/:nid`, `DELETE .../nodes/:nid`.
  - `POST /canvases/:cid/edges`, `PATCH .../edges/:eid`, `DELETE .../edges/:eid`.

**Gate:** `curl` round-trip creates canvas, adds 2 nodes + 1 edge, `GET` returns the authored graph. Typecheck clean. Frontend untouched.

### Stage 16 — MCP tools so CC is the author

**New MCP tools** (all scoped to the currently focused workspace):

| Tool | Args |
|---|---|
| `create_canvas` | `name, description?` → returns `canvas_id` |
| `list_canvases` | — |
| `add_node` | `canvas_id, file_path, x, y, width?, height?, process?` |
| `add_edge` | `canvas_id, src, dst, label?, kind?` |
| `move_node` | `canvas_id, node_id, x, y` |
| `delete_node` | `canvas_id, node_id` |
| `delete_edge` | `canvas_id, edge_id` |

That's it. No seed tool, no auto-import. CC reads the code and authors from scratch based on the user's prompt.

**Gate:** In a CC session, *"create a canvas called 'WebGL Pipeline' and wire up the WebGL chart files."* CC constructs the canvas via these tools; `GET /canvases/:cid` matches what CC described.

### Stage 17 — Frontend: canvases + tabs + live fan-out; delete old pathway

**Frontend:**
- Tab bar at top: one chip per canvas in the active workspace, click to switch, "+" to create (prompts name → POST `/canvases`).
- Canvas-switch loads that canvas's nodes + edges, rebuilds WebGL buffers, recomputes routing.
- Status line: `daemon — workspace: GateStack — canvas: WebGL Pipeline`.
- Drop the tier 0/1 zoom model. Each canvas has its own hand-placed layout.
- Empty state when a workspace has zero canvases: centered copy *"No diagrams yet. Ask Claude to make one — try: 'diagram the WebGL pipeline'."* No modal, no buttons.

**Daemon:**
- Reverse index `file_path → Set<canvas_node_id>` per workspace.
- On PreToolUse/PostToolUse: broadcast one `node.state_change` per canvas instance of that file. A file in 3 canvases pulses 3 boxes.

**Cleanup:**
- Delete `NodeStoreRegistry`, `/workspaces/:id/graph`, `/workspaces/:id/nodes`, `/workspaces/:id/positions`, `/workspaces/:id/relayout`, `/workspaces/:id/selection`, the extraction auto-run on activation.
- Keep the extraction pipeline code (walker, imports) — CC can read it as internal reference when authoring, but it no longer runs automatically.
- Keep health runners; they now broadcast per-canvas-instance same as hook activity.

**Gate:** Fresh workspace → empty canvas list → user says *"diagram the WebGL pipeline"* in CC → canvas appears in a new tab → editing a file pulses the right box.

### Stage 18 — Edge labels + process rendering + multi-select + MCP audit

**Scope:**
- Edge labels drawn on the 2D overlay along the longest segment of each polyline. Pill background so they read over anything.
- Process rendering: nodes with the same `process` value get a subtle rounded outline + process-name pill at the top. (No drag-the-process-as-a-group; just a visual indicator.)
- Multi-select: shift-click to add a node to selection, click-empty-space to clear, drag to move all selected together. Essential when CC drops 20 nodes on a fresh canvas and the user wants to rearrange.
- MCP tool description audit: each tool description must be fully self-sufficient. A fresh CC with zero context about Schematic should be able to read the tool list and produce a reasonable diagram from a prompt like *"diagram the WebGL pipeline."* No references to Schematic source code; no assumed product knowledge.

**Gate:** A canvas with 6 nodes in 2 processes + 5 labeled edges renders cleanly at reasonable zoom levels; shift-click + drag moves multiple nodes as a unit; a fresh CC session can author a canvas end-to-end without reading Schematic's source.

---

## Build dependencies

```
15 ── 16 ── 17 ── 18
```

Strictly sequential — each stage builds on the last.

---

### Stage 19 — Schematic as CC reasoning substrate

The canvas isn't just a picture for humans. It's a captured architectural
structure CC can query to make better code decisions: impact before
refactors, drift detection, keystone identification, cycle smells. Five
read-only MCP tools, all returning structured JSON.

**Tools:**

- `trace_impact(file_path)` — for every canvas in the session's workspace
  that references the file, return node instances + incoming/outgoing
  edges + summary counts. CC calls this before touching a file to
  understand blast radius.
- `audit_canvas(canvas_id)` — check each node's file_path against disk.
  Report missing files (stale), existing files, duplicates. Minimum
  viable drift detection; no import parsing in v1.
- `find_hubs(canvas_id, min_degree?)` — nodes with high in+out edge
  count. Keystone files that warrant extra care when changed.
- `find_orphans(canvas_id)` — zero-edge nodes. Forgotten dependencies or
  dead placeholders.
- `find_cycles(canvas_id)` — DFS-detected edge cycles, typically a
  design smell worth surfacing.

**Scope boundaries:**

- All tools resolve workspace via `sessionWorkspace()` (cwd-first).
- Computations on canvas data already in memory; no new daemon state.
- Descriptions follow the Stage 18d rules (self-sufficient, no assumed
  Schematic knowledge).
- JSON output, not prose.

**Gate:** Fresh CC session, "before you change `http.ts`, run trace_impact
and tell me what would be affected." CC calls it, reads the JSON,
summarizes. Same gate for the other four tools.

---

## Open questions

These should be resolved before Stage 15 code lands — they shape API decisions.

1. **Initial position when CC adds a node.** Does CC always supply `x, y`, or does the server auto-place (e.g. left-to-right grid) when position is omitted? Auto-place is friendlier to CC (it can focus on "which files, which edges" and not think about pixels). Proposed default: if `x, y` omitted, server places in a grid; CC can always override.

2. **Edge-kind vocabulary.** I proposed `"calls" | "imports" | "reads" | "writes" | "control"`. Is that the right set, or should kind be freeform text? Fixed set gives consistent colors; freeform is more expressive. Proposed default: fixed set + a `"custom"` kind where label does the heavy lifting.

3. **Orphan nodes after file deletion.** If CC deletes a file and a canvas node still references its path, what happens? Options: (a) auto-remove the node, (b) mark it as orphaned and show a broken-link visual, (c) do nothing. Proposed default: (b) — show orphaned visually; user can delete or reassign.

4. **CC's judgment about "process" assignments.** When CC draws a canvas from scratch, does it decide which process label each node gets? Or does it leave `process` blank unless the user asks for groupings? Proposed default: CC assigns process labels when the user's prompt implies groupings ("diagram the WebGL pipeline *and group by role*"), leaves them blank otherwise.

5. **Canvas persistence format.** One JSON per canvas vs. one JSON per workspace containing all canvases. Per-canvas means atomic writes on edit; per-workspace means fewer files. Proposed default: per-canvas, because canvases will grow and concurrent edits (CC writing, user dragging) are cleaner when scoped.

---

## Out of scope (explicit no's)

- First-run modal. Empty-state copy is enough.
- Auto-seed-from-directory tool. CC authors from prompts; user can ask for clarity.
- Edge hover tooltips, Mermaid export. Possible later; not on the critical path.
- Orthogonal-routing + obstacle-avoidance work I started earlier. The new pipeline reroutes edges every frame from authored endpoints — routing can be simple until there's a specific canvas where it isn't good enough.
- Repo reorganization (editing the filesystem to match architecture). Not our problem.
- Concurrent / multi-user canvases.
