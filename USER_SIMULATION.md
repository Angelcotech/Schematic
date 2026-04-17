# Schematic — User Simulation

A detailed walkthrough of how a user installs, launches, and works with Schematic end-to-end. Written as a design artifact to stress-test the flow and surface gaps.

---

## The two fundamental questions first

### Is there a Claude terminal inside Schematic?

**In v1, no.** Claude Code runs in the user's existing terminal — same place they've always run it. Schematic is a *companion*, not a replacement. The browser is the **map + dashboard**, not a chat window.

Rationale: Claude Code has features (slash commands, plan mode, MCP configuration, keybinding customization) that would all need reimplementation in a chat UI, and users already have CC configured the way they like. v1 respects that. Schematic's value is the map, the diagnostics, and the bidirectional context — not a second place to type to CC.

**v2 candidate:** an optional embedded chat panel that uses the Claude Agent SDK to talk to the same Claude models. Clicking a node would pre-fill the chat with that node's reference. Would turn Schematic into a full cockpit. Not v1.

### They have to connect to it, right?

**One-time connection at install.** The user runs `schematic install` once, which writes hooks + MCP into their global Claude Code settings. After that, every CC session — in every terminal, in every repo — is already connected. There is no per-session "connect" step.

But the user needs **visibility** that the connection is live. That's a real UX requirement. The browser shows three explicit status indicators at all times:

- **Daemon status:** is the background process running?
- **Active CC session:** has any hook fired recently?
- **Workspace state:** is the current repo being tracked?

You should always be able to glance at the browser and know the answer to "is this working right now?"

---

## Scene 0 — Before the browser ever opens: install

The user opens a terminal. They run:

```
npm install -g schematic
```

That installs two things: the `schematic` CLI and the daemon binary. Nothing starts yet. The user then runs:

```
schematic install
```

The CLI prints:

```
Schematic installer
───────────────────
✔ Writing MCP server entry to ~/.claude/settings.json
✔ Writing hooks (PreToolUse, PostToolUse, UserPromptSubmit) to ~/.claude/settings.json
✔ Creating ~/.schematic/ directory
✔ Starting daemon on port 7777
✔ Daemon responding (uptime: 0s)

Schematic is ready.
  Dashboard: http://localhost:7777
  Stop:      schematic stop
  Help:      schematic --help

Open any Claude Code session and start working normally.
Newly touched repos will appear in the dashboard automatically.
```

If port 7777 is already in use, the installer picks the next free port, tells the user, and writes it into `~/.schematic/config.json` so future runs use the same port.

The user now has:
- Daemon running in the background
- CC globally wired up (MCP + 3 hooks)
- Nothing indexed, no workspaces registered

---

## Scene 1 — User opens the browser

The user visits `http://localhost:7777`.

The page loads. The layout is a single WebGL canvas with a slim top bar, a collapsible left sidebar for workspaces, and a collapsible right sidebar for diagnostics. All sidebars start closed.

The **top bar** shows three status pills from left to right:

```
┌─────────────────────────────────────────────────────────────┐
│  Schematic    ● Daemon      ○ No CC activity    ○ No workspace │
│                (green)       (grey)              (grey)         │
└─────────────────────────────────────────────────────────────┘
```

- **Daemon pill (green ●):** the browser's WebSocket connected successfully — the daemon is alive.
- **CC activity pill (grey ○):** no hook has fired in the last 60 seconds.
- **Workspace pill (grey ○):** no workspace is currently selected in the view.

Below the top bar, a center overlay welcomes the user:

> **Schematic is listening.**
>
> Open any Claude Code session in a project directory and work normally. Your repo will appear here within a few seconds of the first edit, read, or question.
>
> No per-project setup required.
>
> — [Dismiss]

The user dismisses the overlay. They see an empty dark canvas. The three status pills are visible at all times — that's how they know the connection is live.

---

## Scene 2 — CC touches a repo for the first time

The user opens a separate terminal (say, in their IDE's integrated terminal, or a standalone terminal — wherever they normally run CC). They `cd ~/GateStack-Pro/` and start `claude`.

They ask a simple question: *"what does the G1 vertex engine do currently?"*

CC reads two files to answer. The moment the first `PreToolUse(Read)` hook fires, three things happen on the daemon side:

1. **The hook POSTs** to `http://localhost:7777/hook` with a payload like:
   ```json
   {
     "event": "PreToolUse",
     "tool": "Read",
     "file": "/Users/transcience/GateStack-Pro/src/engine/g1_vertex.ts",
     "cwd": "/Users/transcience/GateStack-Pro",
     "session_id": "abc-123",
     "timestamp": 1744000000000
   }
   ```

2. **The daemon walks up** from `cwd` looking for a repo root. It finds `.git/` at `/Users/transcience/GateStack-Pro/`. It hashes that path → generates workspace ID `ws_f2a81c3d`. This is a new workspace.

3. **The daemon checks** for `.schematic.json` at the repo root. Not present. So no workspace is created yet — the daemon emits a one-time registration toast and waits for explicit activation.

Immediately on the browser side, the top bar changes:

```
●  Daemon       ●  CC activity (session abc-123)     ○ No workspace
   (green)         (yellow — hook just fired)
```

A toast slides in from the right:

> **New repo detected: GateStack-Pro**
> `~/GateStack-Pro` — 0 files indexed, 0 health sources running.
>
> [Activate — start visualizing]   [Skip for now]   [Always skip this path]

The user clicks **Activate**.

---

## Scene 3 — Activation

The toast replaces with a progress panel docked to the right side:

```
Activating GateStack-Pro
────────────────────────
✔ Walking directory tree
✔ Applying .gitignore rules
✔ Parsing imports (file level)
  └─ 847 / 3,104 files
```

Every few hundred milliseconds, the browser receives `workspace.extraction_progress` events and updates the count. This takes ~8 seconds on a 3k-file TypeScript repo. Progress streams; nothing blocks.

Once file-level extraction completes, the log continues:

```
✔ Building mention index (Aho-Corasick)
✔ Writing cache to ~/.schematic/workspaces/ws_f2a81c3d/
✔ Starting health sources
  └─ tsc --watch (found tsconfig.json)
  └─ eslint --watch (found .eslintrc.cjs)
✔ Ready.
```

The canvas fades in. ~14 module rectangles resolve into position (force-directed auto-layout seeded with a hierarchical bias). Module names label each rectangle. Thick aggregated edges cross between them. The top bar updates:

```
●  Daemon    ●  CC activity     ●  Workspace: GateStack-Pro (active)
```

The **left sidebar** (workspaces) is now openable — the user clicks the chevron and sees:

```
Workspaces
──────────────────────────────
● GateStack-Pro                active   0 errors     <last touched 8s ago>
                               ← currently viewing
```

The **right sidebar** (diagnostics) shows "No issues" since tsc hasn't returned results yet. A few seconds later it refreshes:

```
Diagnostics
──────────────────────────────
Engine module
  ● parser.ts           1 error (tsc)
  ● features.ts         2 errors (tsc)
  ● vertex_classifier.ts 1 error (tsc)

Rendering module
  ⚠ shaders.ts          1 warning (eslint)
```

The `Engine` module rectangle on the canvas now has a small red badge in its corner ("4 errors"). The user didn't know this. They wouldn't have discovered it until they ran tsc manually or hit CI.

---

## Scene 4 — The bidirectional moment

The user zooms into `Engine`. The module rectangle expands, files resolve, push-apart physics animate the transition smoothly. They click `parser.ts`. The right sidebar expands with the full diagnostic:

```
parser.ts  — 1 error
──────────────────────────────
Line 78, column 14:
  Property 'highWater' does not exist on type 'BarState'.

Source: tsc
Detected: 14 seconds ago
```

They switch back to their CC terminal and type: *"fix all the BarState.highWater regressions — there are three files affected."*

At the exact moment they press Enter:

**On the CC side:**
- The `UserPromptSubmit` hook fires, carrying the prompt text
- The hook script POSTs to `/hook` with the prompt + cwd + session_id
- The daemon runs the Aho-Corasick scan. `BarState` matches `bar_state.ts` (a type definition file) and — because the user also mentioned "three files affected" — the diagnostic aggregation infers the three broken files as mention candidates
- All matched nodes get `last_mention_ts = now`, `last_mention_source = "user"`
- The daemon returns the injection payload:
  ```
  <arch-context>
  User focused: parser.ts (Engine)
  Recently mentioned: BarState type (bar_state.ts)
  Current diagnostics (4 errors across 3 files):
    - parser.ts:78: Property 'highWater' does not exist on type 'BarState'
    - features.ts:142: Property 'highWater' does not exist on type 'BarState'
    - features.ts:167: Property 'highWater' does not exist on type 'BarState'
    - vertex_classifier.ts:89: Property 'highWater' does not exist on type 'BarState'
  </arch-context>
  ```
- CC receives the prompt with that context block prepended. It now has exact file paths, exact lines, exact messages — before it makes any tool call.

**On the browser side (user's other monitor):**
- `parser.ts`, `features.ts`, `vertex_classifier.ts`, and `bar_state.ts` all get a subtle mention glow (soft yellow-white halo based on `last_mention_ts`, fading over ~10 minutes)
- The top bar's CC activity pill pulses briefly

**Then CC works:**
- CC calls `Edit` on `parser.ts`
- `PreToolUse(Edit)` fires → `parser.ts` node transitions to `ai_intent = "planning"` (bright yellow halo)
- CC's edit completes → `PostToolUse(Edit)` fires with success → node transitions to `ai_intent = "modified"` (bright green halo)
- A few hundred milliseconds later, CC edits `features.ts`, same cycle
- Then `vertex_classifier.ts`, same cycle

**Then tsc catches up:**
- tsc-watch was running the whole time
- Within ~2 seconds of the last edit, tsc re-evaluates, emits new diagnostics
- The server sees all 4 errors resolved
- All three files flip from `health = "error"` back to `health = "ok"`
- Red badges fade. Dashed outlines resolve to solid. The module's aggregate error count drops from 4 to 0.

The user watched it happen without running anything. The map showed the full story.

---

## Scene 5 — The user organizes

An hour later, the user is looking at the top-level view. They think: *"Engine and Live Pipeline should be adjacent — they're tightly coupled."*

They click-and-hold on the `Engine` rectangle and drag it. Every file and symbol inside Engine (~80 nodes) translates together as one unit — single shader transform, one draw call. `Prob Engine`, which was in the way, smoothly displaces to the right (push-apart physics). The user drops `Engine` next to `Live Pipeline`.

On mouse-up:
- A `user.node_moved` event broadcasts with the new positions
- `manually_positioned = true` on `Engine` and all its descendants
- Positions are persisted to `~/.schematic/workspaces/ws_f2a81c3d/positions.json` (debounced 500ms)
- The module-to-module edge between Engine and Live Pipeline visibly shortens (less clutter)

The user closes the browser tab. Nothing happens. The daemon is still running. CC is still wired. Edits still show up — they just aren't rendered anywhere right now.

---

## Scene 6 — Coming back the next day

The user's machine hasn't rebooted. They open the browser: `localhost:7777`.

The canvas loads instantly with everything exactly as they left it — `Engine` still next to `Live Pipeline`, their drag persisted. The top bar shows:

```
●  Daemon (uptime: 17h 42m)    ○ No recent CC activity    ● Workspace: GateStack-Pro
```

They switch to their terminal, resume their work. The moment CC makes its first tool call, the activity pill goes live.

---

## Scene 7 — Switching repos mid-session

The user `cd`s to `~/GammaGate/` in a different terminal and starts a new CC session. They ask a question. CC reads a file.

**On the daemon side:**
- Hook fires with `cwd = /Users/transcience/GammaGate`
- Daemon walks up, finds git root, hashes → workspace ID `ws_8c7e2f1a` (new)
- Checks for `.schematic.json` at the root — **found!** (the user committed one months ago with custom module definitions)
- Because the marker is present, auto-activation kicks in
- Graph extraction streams
- `tsc-watch` starts against GammaGate's tsconfig

**On the browser:**
The user is currently viewing GateStack-Pro. A subtle notification appears:

> GammaGate auto-activated
> Custom modules from .schematic.json loaded.
>
> [Switch to GammaGate]   [Keep viewing GateStack-Pro]

The left sidebar workspaces list now shows two entries:

```
Workspaces
──────────────────────────────
● GateStack-Pro                active     0 errors     ← viewing
● GammaGate                    active     0 errors     <just activated>
```

The user clicks the GammaGate row. The canvas fades to the GammaGate graph. Both workspaces are running in parallel — hooks from either repo get routed correctly. The user can keep a browser tab per workspace if they want simultaneous views.

---

## Scene 8 — The always-visible status indicators

At any moment, the user can glance at the browser and know exactly what's going on. The **top bar** is the permanent answer:

| Pill | States | Meaning |
|------|--------|---------|
| Daemon | **●** green / **✕** red | Is the daemon process alive and reachable? |
| CC activity | **●** green (active in last 10s) / **●** yellow (active in last 60s) / **○** grey (idle) | Has a hook fired recently? |
| Workspace | **●** green (active) / **◐** amber (paused) / **○** grey (registered, not active) / **✕** red (error) | State of the currently viewed workspace |

Hovering any pill shows a tooltip:

```
Daemon ● healthy
────────────────
Uptime: 17h 42m
Port: 7777
Sessions tracked: 2
Events processed: 4,821
```

```
CC activity ● active
────────────────
Last hook: 3s ago (PreToolUse:Edit)
Session: abc-123
Active for: 14m
```

```
Workspace ● active — GateStack-Pro
────────────────
Files: 3,104
Symbols: 12,847 (lazy-loaded)
Health sources: tsc ●, eslint ●
Last change: 18s ago
```

If anything is wrong, the pill color tells you. Click-through gives you a detailed status panel.

---

## Scene 9 — The event feed (debug/trust)

The user wants to verify "is CC actually wired up?" even before any hooks fire. They open the **bottom drawer** (keyboard: `` ` `` backtick). An event feed unfolds:

```
14:37:22  PreToolUse(Read)     g1_vertex.ts        GateStack-Pro
14:37:22  PostToolUse(Read)    g1_vertex.ts        GateStack-Pro   (6ms)
14:37:29  UserPromptSubmit     "fix all the BarS…"  GateStack-Pro
14:37:29  context.inject       4 nodes mentioned    GateStack-Pro
14:37:30  PreToolUse(Edit)     parser.ts           GateStack-Pro
14:37:30  PostToolUse(Edit)    parser.ts ✔         GateStack-Pro   (42ms)
14:37:31  health.updated       parser.ts ok        GateStack-Pro   (tsc)
```

This is the "yes, it's really wired up" reassurance. Every hook, every context injection, every health update streams through here. If something isn't showing up on the map, this is the first place you look.

The drawer is closeable; most users will leave it closed after the first session.

---

## Scene 10 — Pausing and disabling

The user decides they don't want Schematic running for GammaGate today — it's a low-stakes exploration session and they don't want `tsc --watch` spinning. They right-click the GammaGate row in the workspace sidebar:

```
GammaGate
  ⏸  Pause           (keeps graph cache, stops tsc/eslint)
  ⊘  Disable         (stops tracking, opt-out marker writes .schematic-ignore)
  🔄 Re-index        (full rebuild)
  ✕  Forget          (removes from registry, deletes ~/.schematic/workspaces/<id>/)
```

They click **Pause**. The workspace pill turns amber. tsc/eslint processes shut down gracefully. Hooks from `cwd = /Users/transcience/GammaGate/` are now dropped (no state updates). The cached graph and positions remain. When they want it back, they right-click → **Resume**, and health sources spin back up within seconds.

---

## Scene 11 — Stopping and uninstalling

The user closes their laptop at night. Nothing changes — daemon keeps running as a user-level process.

If they want to explicitly shut down:

```
schematic stop
```

Prints:
```
Stopping daemon...
✔ Shutting down 2 active workspaces
✔ Persisting positions
✔ Stopping 4 health source processes
✔ Closing port 7777
Schematic stopped.
```

If they want to fully uninstall:

```
schematic uninstall
npm uninstall -g schematic
```

The uninstall removes the MCP entry and hooks from `~/.claude/settings.json` (leaving everything else in that file intact), stops the daemon, and offers to delete or keep `~/.schematic/` (so positions and cache survive a reinstall if they want).

---

## The connection model, summarized

There are three distinct "connections" a user should understand, each visible and testable:

| Connection | Established when | Visible via | How to verify |
|------------|------------------|-------------|---------------|
| **Browser ↔ Daemon** | Opening `localhost:7777` | Daemon status pill | Refresh the page; pill should turn green |
| **CC ↔ Daemon** | Running `schematic install` | CC activity pill | Run any CC command; pill should flash |
| **Workspace active** | Auto-marker OR manual activate | Workspace status pill | Check left sidebar |

All three are first-class in the top bar. The user never has to guess.

---

## Gaps the walkthrough surfaced — to fold into BUILDING_PLAN.md

1. **Install UX spec** — `schematic install` output, port-conflict fallback, uninstall flow.
2. **Top bar status pills** — a new UI component codifying the three-connection model. Needs visual spec and hover-tooltip content.
3. **Event feed drawer** — bottom-drawer debug/trust panel. Event retention cap, filtering, keyboard shortcut.
4. **Toast policy** — first-time registration toast vs. subsequent silence; per-path "always skip" option; configurable in settings.
5. **Workspace context-menu actions** — pause, disable, re-index, forget, resume, with exact state transitions specified.
6. **Progress streaming** — extraction progress events need a defined cadence and granularity (files/symbols/modules).
7. **Session-level CC identity** — hook payloads include `session_id` so the daemon can show "session X active," distinguishing multiple simultaneous CC sessions on the same or different repos.
8. **Chat panel (deferred to v2)** — explicit non-goal for v1, documented as a future option using Claude Agent SDK.
9. **"Always visible" connection model** — the three-pill top bar should be codified as a ninth design invariant: *the user must always be able to see whether the system is working.*
