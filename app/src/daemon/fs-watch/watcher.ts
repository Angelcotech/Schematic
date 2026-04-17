// Per-workspace filesystem watcher. Uses chokidar (abstracts FSEvents /
// inotify / ReadDirectoryChangesW). Emits coalesced "changed / added /
// removed" sets every ~150ms so a `git checkout` burst doesn't fire a
// hundred re-extractions.

import chokidar, { type FSWatcher } from "chokidar";
import { relative } from "node:path";

export interface FsChangeBatch {
  added: string[];
  changed: string[];
  removed: string[];
}

const DEBOUNCE_MS = 150;

// Built-in ignore globs mirroring the walker's defaults.
const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.schematic/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.vite/**",
  "**/.turbo/**",
  "**/.cache/**",
];

export function startWatcher(
  root: string,
  onBatch: (batch: FsChangeBatch) => void,
): () => void {
  const watcher: FSWatcher = chokidar.watch(root, {
    ignored: IGNORE_GLOBS,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 40,
    },
    persistent: true,
  });

  const pending = { added: new Set<string>(), changed: new Set<string>(), removed: new Set<string>() };
  let flushTimer: NodeJS.Timeout | null = null;

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush(): void {
    flushTimer = null;
    if (pending.added.size === 0 && pending.changed.size === 0 && pending.removed.size === 0) return;
    const batch: FsChangeBatch = {
      added: Array.from(pending.added),
      changed: Array.from(pending.changed),
      removed: Array.from(pending.removed),
    };
    pending.added.clear();
    pending.changed.clear();
    pending.removed.clear();
    onBatch(batch);
  }

  watcher.on("add", (abs) => {
    pending.added.add(relative(root, abs));
    scheduleFlush();
  });
  watcher.on("change", (abs) => {
    pending.changed.add(relative(root, abs));
    scheduleFlush();
  });
  watcher.on("unlink", (abs) => {
    pending.removed.add(relative(root, abs));
    scheduleFlush();
  });
  watcher.on("error", (err) => {
    console.error("[schematic] fs watcher error:", err);
  });

  return () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // Detach listeners so further batches don't fire, and just leak the
    // underlying watcher. chokidar's close() on macOS can block the main
    // thread for tens of seconds while FSEvents queues drain — enough to
    // stall every other ongoing request. The workspace watcher is scoped
    // to the process lifetime anyway (workspaces come back on daemon
    // restart), so letting it linger until process exit is fine.
    watcher.removeAllListeners();
  };
}
