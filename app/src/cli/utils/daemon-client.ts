// Thin HTTP client used by every CLI command that talks to the daemon.
// No retries, no silent fallbacks — just `fetch`, surface errors verbatim.

import { readOrInitConfig } from "../../daemon/persist/config.js";
import type { Workspace } from "../../shared/workspace.js";

export async function daemonUrl(path: string): Promise<string> {
  const cfg = await readOrInitConfig();
  return `http://127.0.0.1:${cfg.port}${path}`;
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const r = await fetch(await daemonUrl("/status"));
    return r.ok;
  } catch (e) {
    // Any connectivity error to localhost means the daemon is not reachable
    // right now. ECONNREFUSED = not bound. ECONNRESET / ETIMEDOUT = tearing
    // down mid-request (happens during stop). We treat all of these as "not
    // running" because that's the semantic the caller wants — is the daemon
    // available for commands? Unexpected non-network errors still surface.
    const direct = (e as NodeJS.ErrnoException).code;
    const nested = ((e as { cause?: NodeJS.ErrnoException }).cause)?.code;
    const code = direct ?? nested;
    const networkErrors = new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ]);
    if (code && networkErrors.has(code)) return false;
    throw e;
  }
}

export async function getStatus(): Promise<{
  uptime_ms: number;
  workspaces: number;
  events_processed: number;
  ws_clients: number;
}> {
  const r = await fetch(await daemonUrl("/status"));
  if (!r.ok) throw new Error(`[schematic] /status failed: ${r.status}`);
  return r.json() as Promise<{
    uptime_ms: number;
    workspaces: number;
    events_processed: number;
    ws_clients: number;
  }>;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const r = await fetch(await daemonUrl("/workspaces"));
  if (!r.ok) throw new Error(`[schematic] /workspaces failed: ${r.status}`);
  return r.json() as Promise<Workspace[]>;
}

export async function createWorkspace(path: string): Promise<Workspace> {
  const r = await fetch(await daemonUrl("/workspaces"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(`[schematic] POST /workspaces failed: ${r.status} ${await r.text()}`);
  return r.json() as Promise<Workspace>;
}

export async function transitionWorkspace(id: string, to: "active" | "paused" | "disabled"): Promise<Workspace> {
  const r = await fetch(await daemonUrl(`/workspaces/${id}/state`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  if (!r.ok) throw new Error(`[schematic] state transition failed: ${r.status} ${await r.text()}`);
  return r.json() as Promise<Workspace>;
}

export async function forgetWorkspace(id: string): Promise<void> {
  const r = await fetch(await daemonUrl(`/workspaces/${id}`), { method: "DELETE" });
  if (!r.ok) throw new Error(`[schematic] forget failed: ${r.status} ${await r.text()}`);
}

export async function resolveCwd(cwd: string): Promise<{
  workspace: Workspace | null;
  shouldAutoActivate: boolean;
  root: string | null;
}> {
  const u = new URL(await daemonUrl("/resolve"));
  u.searchParams.set("cwd", cwd);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`[schematic] /resolve failed: ${r.status}`);
  return r.json() as Promise<{
    workspace: Workspace | null;
    shouldAutoActivate: boolean;
    root: string | null;
  }>;
}

export async function shutdownDaemon(): Promise<void> {
  const r = await fetch(await daemonUrl("/shutdown"), { method: "POST" });
  if (!r.ok) throw new Error(`[schematic] shutdown failed: ${r.status}`);
}
