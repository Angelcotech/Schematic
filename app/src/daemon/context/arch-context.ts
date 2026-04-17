// Builds the <schematic-context> block the daemon returns on
// UserPromptSubmit hooks. CC prepends the block to the prompt reaching
// Claude. Keeps the map and the prompt in lockstep: click a file → say
// "fix it" → Claude knows which file.
//
// Content is intentionally terse (<250 tokens) so we don't crowd out the
// user's actual prompt. Includes:
//   - The workspace name
//   - The currently selected node (file/module) if any
//   - Its direct neighbors (imports + imported by), capped at a few each

import type { Edge } from "../../shared/edge.js";
import type { NodeState } from "../../shared/node-state.js";
import type { Workspace } from "../../shared/workspace.js";

const MAX_NEIGHBORS = 6;

export interface ArchContextInputs {
  workspace: Workspace;
  nodes: NodeState[];
  edges: Edge[];
}

export function buildArchContext(inputs: ArchContextInputs): string {
  const { workspace, nodes, edges } = inputs;

  const selected = nodes.find((n) => n.user_state === "selected");
  const lines: string[] = [];
  lines.push("<schematic-context>");
  lines.push(`Workspace: ${workspace.name}`);

  if (!selected) {
    lines.push("(No node is currently selected in the Schematic map.)");
    lines.push("</schematic-context>");
    return lines.join("\n");
  }

  const kindLabel =
    selected.kind === "file" ? "File"
    : selected.kind === "module" ? "Module"
    : selected.kind === "symbol" ? "Symbol"
    : selected.kind;
  lines.push(`Selected ${kindLabel}: ${selected.id}`);

  if (selected.kind === "file") {
    const out = edges.filter((e) => e.source === selected.id).map((e) => e.target);
    const inn = edges.filter((e) => e.target === selected.id).map((e) => e.source);
    formatNeighborGroup(lines, "imports", out);
    formatNeighborGroup(lines, "imported by", inn);
  } else if (selected.kind === "module") {
    const childIds = new Set(selected.children ?? []);
    const crossIn = edges
      .filter((e) => !childIds.has(e.source) && childIds.has(e.target))
      .map((e) => e.source);
    const crossOut = edges
      .filter((e) => childIds.has(e.source) && !childIds.has(e.target))
      .map((e) => e.target);
    lines.push(`Contains ${childIds.size} files.`);
    formatNeighborGroup(lines, "external imports (from outside this module)", unique(crossOut));
    formatNeighborGroup(lines, "external consumers (outside this module importing it)", unique(crossIn));
  } else if (selected.kind === "symbol") {
    if (selected.signature) lines.push(`Signature: ${selected.signature}`);
    if (selected.parent) lines.push(`In file: ${selected.parent}`);
  }

  lines.push("</schematic-context>");
  return lines.join("\n");
}

function formatNeighborGroup(out: string[], label: string, items: string[]): void {
  if (items.length === 0) {
    out.push(`${label}: (none)`);
    return;
  }
  const shown = items.slice(0, MAX_NEIGHBORS);
  const more = items.length > MAX_NEIGHBORS ? ` (+${items.length - MAX_NEIGHBORS} more)` : "";
  out.push(`${label}: ${shown.join(", ")}${more}`);
}

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
