// Legal workspace state transitions. Three states total (post-efficiency
// pass): active, paused, disabled. Pre-activation = no registry record.

import type { WorkspaceState } from "../../shared/workspace.js";

export const LEGAL_TRANSITIONS: Record<WorkspaceState, readonly WorkspaceState[]> = {
  active: ["paused", "disabled"],
  paused: ["active", "disabled"],
  disabled: ["active"],
};

export function canTransition(from: WorkspaceState, to: WorkspaceState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

// Hard-fails on illegal transition per Build Law 1 (hardwire connections).
export function assertTransition(from: WorkspaceState, to: WorkspaceState): void {
  if (!canTransition(from, to)) {
    throw new Error(`[schematic] illegal workspace state transition: ${from} → ${to}`);
  }
}
