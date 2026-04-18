#!/usr/bin/env node
// Copies the built frontend into app/dist/web/ so the daemon can serve it
// as static content at http://127.0.0.1:<port>/. Also copies README.md and
// LICENSE into app/ so `npm pack` (which runs from app/ via the files
// allowlist) ships them. Runs after both workspace builds complete.

import { cp, rm, stat, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const src = resolve(repoRoot, "frontend/dist");
const dst = resolve(repoRoot, "app/dist/web");

try {
  await stat(src);
} catch {
  console.error(`[copy-frontend] ${src} does not exist — run \`pnpm --filter @schematic/frontend build\` first.`);
  process.exit(1);
}

await rm(dst, { recursive: true, force: true });
await cp(src, dst, { recursive: true });
console.log(`[copy-frontend] ${src} → ${dst}`);

for (const name of ["README.md", "LICENSE"]) {
  await copyFile(resolve(repoRoot, name), resolve(repoRoot, "app", name));
  console.log(`[copy-frontend] ${name} → app/${name}`);
}
