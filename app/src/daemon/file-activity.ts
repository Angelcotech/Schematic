// Per-workspace file activity store. Replaces NodeStoreRegistry for live
// state in the canvas era — activity is a property of a file (on disk),
// not of a canvas node. When a file.activity event fires, the browser fans
// it out to every canvas node referencing that file_path.
//
// Kept in-memory — activity is ephemeral. Daemon restart wipes activity
// state (files will re-pulse on the next hook anyway).

import { relative } from "node:path";
import type { FileActivity } from "../shared/file-activity.js";
import type { AiIntent, Health } from "../shared/node-state.js";
import type { HookPayload } from "../shared/hook-payload.js";
import type { Workspace } from "../shared/workspace.js";

// Same intent-derivation logic that used to live in node-store.ts. Mapping
// is deliberately narrow — reads, plans, modifies, deletes, fails. Anything
// else returns null (no state change).
function intentForHook(payload: HookPayload): { intent: AiIntent; health?: Health } | null {
  const { event, tool } = payload;
  if (!tool) return null;

  const isReadish = tool === "Read" || tool === "Grep" || tool === "Glob";
  const isWritish = tool === "Edit" || tool === "Write" || tool === "MultiEdit";
  const isBashDelete =
    tool === "Bash" &&
    typeof payload.prompt === "string" &&
    /(^|\s)(rm|mv)\s/.test(payload.prompt);

  if (event === "PreToolUse") {
    if (isWritish) return { intent: "planning" };
    if (isReadish) return { intent: "reading" };
    return null;
  }
  if (event === "PostToolUse") {
    if (isBashDelete) return { intent: "deleted" };
    if (isWritish) {
      return payload.success === false
        ? { intent: "failed", health: "error" }
        : { intent: "modified" };
    }
    return null;
  }
  return null;
}

function severityRank(s: "error" | "warning" | "info"): number {
  return s === "error" ? 3 : s === "warning" ? 2 : 1;
}

export class WorkspaceFileActivity {
  private readonly files = new Map<string, FileActivity>();

  all(): FileActivity[] {
    return Array.from(this.files.values());
  }

  get(filePath: string): FileActivity | undefined {
    return this.files.get(filePath);
  }

  // Translate a hook event into a file-path activity update. Returns the
  // updated activity for broadcast, or null if the hook didn't produce a
  // meaningful state change.
  applyHook(workspace: Workspace, payload: HookPayload): FileActivity | null {
    if (!payload.target) return null;

    const derived = intentForHook(payload);
    if (!derived) return null;

    const filePath = relative(workspace.root, payload.target);
    if (filePath.startsWith("..")) return null; // outside workspace

    let activity = this.files.get(filePath);
    if (!activity) {
      activity = {
        file_path: filePath,
        ai_intent: "idle",
        health: "unknown",
      };
      this.files.set(filePath, activity);
    }

    activity.ai_intent = derived.intent;
    activity.ai_intent_since = payload.timestamp;
    activity.ai_intent_tool = payload.tool ?? undefined;
    activity.ai_intent_session = payload.session_id;
    activity.last_ai_touch = payload.timestamp;
    if (derived.health) {
      activity.health = derived.health;
      activity.health_source = "ai_intent";
      activity.health_updated_ts = payload.timestamp;
    }

    return { ...activity };
  }

  // Apply a diagnostic snapshot from a single health source (tsc, eslint,
  // etc.). Files the source covers but doesn't flag → ok. Files outside
  // the source's scope are left alone. Returns changed file paths.
  applyHealthSnapshot(
    source: string,
    covers: (filePath: string) => boolean,
    diagnostics: Array<{ file_path: string; severity: "error" | "warning" | "info"; message: string }>,
  ): string[] {
    const byFile = new Map<string, { severity: "error" | "warning" | "info"; count: number; firstMsg: string }>();
    for (const d of diagnostics) {
      const existing = byFile.get(d.file_path);
      if (!existing) {
        byFile.set(d.file_path, { severity: d.severity, count: 1, firstMsg: d.message });
      } else {
        existing.count += 1;
        if (severityRank(d.severity) > severityRank(existing.severity)) existing.severity = d.severity;
      }
    }

    const changed: string[] = [];
    const now = Date.now();

    // Ensure every file in the diagnostic report has an entry (hook-only
    // flow never touched these paths, but health runners still need to
    // report them).
    for (const filePath of byFile.keys()) {
      if (!this.files.has(filePath)) {
        this.files.set(filePath, { file_path: filePath, ai_intent: "idle", health: "unknown" });
      }
    }
    // Also ensure files the source covers have entries so we can downgrade
    // error→ok when they compile clean.
    // (Callers walking their own file list would pass in-scope files; here
    // we only have the diagnostics list to work from. Coverage transitions
    // to `ok` happen lazily when the next file event comes through.)

    for (const activity of this.files.values()) {
      const inDiag = byFile.get(activity.file_path);
      const inScope = covers(activity.file_path);

      if (inDiag) {
        const newHealth = inDiag.severity === "info" ? "warning" : inDiag.severity;
        const newDetail = inDiag.count === 1
          ? inDiag.firstMsg
          : `${inDiag.firstMsg} (+${inDiag.count - 1} more)`;
        if (
          activity.health !== newHealth ||
          activity.health_detail !== newDetail ||
          activity.health_source !== source
        ) {
          activity.health = newHealth;
          activity.health_detail = newDetail;
          activity.health_source = source;
          activity.health_updated_ts = now;
          changed.push(activity.file_path);
        }
      } else if (inScope) {
        const shouldOwn = activity.health_source === source || activity.health === "unknown";
        if (shouldOwn && activity.health !== "ok") {
          activity.health = "ok";
          activity.health_detail = undefined;
          activity.health_source = source;
          activity.health_updated_ts = now;
          changed.push(activity.file_path);
        }
      }
    }

    return changed;
  }

  // Decay stale non-idle activity back to idle.
  applyDecay(now: number): FileActivity[] {
    const changed: FileActivity[] = [];
    for (const activity of this.files.values()) {
      const since = activity.ai_intent_since ?? 0;
      const age = now - since;

      const threshold =
        activity.ai_intent === "reading" ? 60_000
        : activity.ai_intent === "planning" ? 30_000
        : activity.ai_intent === "modified" ? 300_000
        : activity.ai_intent === "failed" ? 600_000
        : activity.ai_intent === "deleted" ? 600_000
        : Infinity;

      if (activity.ai_intent !== "idle" && age > threshold) {
        activity.ai_intent = "idle";
        activity.ai_intent_since = undefined;
        activity.ai_intent_tool = undefined;
        activity.ai_intent_session = undefined;
        changed.push({ ...activity });
      }
    }
    return changed;
  }
}

export class FileActivityRegistry {
  private readonly byWorkspace = new Map<string, WorkspaceFileActivity>();

  getOrCreate(workspaceId: string): WorkspaceFileActivity {
    let store = this.byWorkspace.get(workspaceId);
    if (!store) {
      store = new WorkspaceFileActivity();
      this.byWorkspace.set(workspaceId, store);
    }
    return store;
  }

  get(workspaceId: string): WorkspaceFileActivity | undefined {
    return this.byWorkspace.get(workspaceId);
  }

  drop(workspaceId: string): void {
    this.byWorkspace.delete(workspaceId);
  }

  all(): Array<[string, WorkspaceFileActivity]> {
    return Array.from(this.byWorkspace.entries());
  }
}
