export type WorkspaceState = "active" | "paused" | "disabled";

export interface Workspace {
  id: string;
  root: string;
  name: string;
  git_remote?: string;
  state: WorkspaceState;
  created_at: number;
  last_touched_at: number;
}
