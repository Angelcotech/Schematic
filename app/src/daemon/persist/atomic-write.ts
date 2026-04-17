import { writeFile, rename } from "node:fs/promises";

// Atomic write: write to a sibling tmp file, then rename. A crash mid-write
// leaves either the old file intact or the new file fully written — never a
// half-written file.
export async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}
