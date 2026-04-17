// Module detection. Default: each top-level directory is a module and files
// at the repo root land in a virtual "Root" module. Override: parse
// `.schematic.json` for a `modules` section mapping name → glob patterns.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import type { WalkedFile } from "./walker.js";

export interface ModuleDef {
  name: string;
  files: WalkedFile[];
}

interface SchematicJSONConfig {
  modules?: Record<string, { paths: string[] }>;
}

async function readSchematicJson(root: string): Promise<SchematicJSONConfig | null> {
  try {
    const raw = await readFile(join(root, ".schematic.json"), "utf8");
    return JSON.parse(raw) as SchematicJSONConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

const ROOT_MODULE_NAME = "Root";

function topLevelDir(relPath: string): string {
  const i = relPath.indexOf("/");
  return i === -1 ? ROOT_MODULE_NAME : relPath.slice(0, i);
}

export async function detectModules(root: string, files: WalkedFile[]): Promise<ModuleDef[]> {
  const config = await readSchematicJson(root);

  // Explicit modules from .schematic.json — each has path globs that claim files.
  if (config?.modules) {
    const buckets = new Map<string, WalkedFile[]>();
    // Order preserved so the declared module ordering drives layout order.
    const moduleOrder: string[] = [];

    const matchers = new Map<string, ReturnType<typeof ignore>>();
    for (const [name, def] of Object.entries(config.modules)) {
      const m = ignore();
      m.add(def.paths);
      matchers.set(name, m);
      buckets.set(name, []);
      moduleOrder.push(name);
    }

    const unclaimed: WalkedFile[] = [];
    for (const file of files) {
      let claimed = false;
      for (const [name, matcher] of matchers.entries()) {
        if (matcher.ignores(file.relativePath)) {
          buckets.get(name)!.push(file);
          claimed = true;
          break;
        }
      }
      if (!claimed) unclaimed.push(file);
    }

    const out: ModuleDef[] = moduleOrder.map((name) => ({ name, files: buckets.get(name)! }));
    if (unclaimed.length > 0) out.push({ name: ROOT_MODULE_NAME, files: unclaimed });
    return out.filter((m) => m.files.length > 0);
  }

  // Default: group by top-level directory.
  const buckets = new Map<string, WalkedFile[]>();
  for (const file of files) {
    const key = topLevelDir(file.relativePath);
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(file);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, files]) => ({ name, files }));
}
