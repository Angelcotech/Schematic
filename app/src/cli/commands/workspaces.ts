import { listWorkspaces, forgetWorkspace } from "../utils/daemon-client.js";

export async function workspacesList(): Promise<void> {
  const list = await listWorkspaces();
  if (list.length === 0) {
    console.log("(no workspaces registered)");
    return;
  }
  for (const ws of list) {
    const age = Math.floor((Date.now() - ws.last_touched_at) / 1000);
    console.log(`${ws.id}  ${ws.state.padEnd(8)}  ${ws.name}  (${age}s since last touch)`);
    console.log(`  ${ws.root}`);
  }
}

export async function workspacesForget(id: string): Promise<void> {
  await forgetWorkspace(id);
  console.log(`✔ forgot workspace ${id}`);
}
