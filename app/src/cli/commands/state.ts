import { resolveCwd, createWorkspace, transitionWorkspace } from "../utils/daemon-client.js";

async function requireWorkspaceId(cwd: string): Promise<string> {
  const r = await resolveCwd(cwd);
  if (!r.workspace) {
    throw new Error(`[schematic] no workspace registered for ${cwd}. Run 'schematic activate' first.`);
  }
  return r.workspace.id;
}

export async function activate(cwd: string): Promise<void> {
  const r = await resolveCwd(cwd);
  if (r.workspace) {
    if (r.workspace.state === "active") {
      console.log(`↺ already active: ${r.workspace.name}`);
      return;
    }
    const updated = await transitionWorkspace(r.workspace.id, "active");
    console.log(`✔ activated: ${updated.name}`);
    return;
  }
  if (!r.root) {
    throw new Error(`[schematic] no repo root found at or above ${cwd}`);
  }
  const ws = await createWorkspace(r.root);
  console.log(`✔ created and activated: ${ws.name} (${ws.id})`);
}

export async function pause(cwd: string): Promise<void> {
  const id = await requireWorkspaceId(cwd);
  const updated = await transitionWorkspace(id, "paused");
  console.log(`✔ paused: ${updated.name}`);
}

export async function resume(cwd: string): Promise<void> {
  const id = await requireWorkspaceId(cwd);
  const updated = await transitionWorkspace(id, "active");
  console.log(`✔ resumed: ${updated.name}`);
}

export async function disable(cwd: string): Promise<void> {
  const id = await requireWorkspaceId(cwd);
  const updated = await transitionWorkspace(id, "disabled");
  console.log(`✔ disabled: ${updated.name}`);
}
