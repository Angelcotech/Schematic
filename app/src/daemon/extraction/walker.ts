// Directory walker for a workspace. Respects .gitignore and a built-in
// set of always-ignored paths (node_modules, .git, build output, etc.).
// Returns a flat list of files with the metadata the rest of the pipeline
// needs — mtime for dirtiness, size for tooltips, language by extension.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import ignore from "ignore";

export interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  byte_size: number;
  mtime_ms: number;
  language: string | undefined;
}

// Built-in ignores — applied before user's .gitignore so we never descend
// into these even if the user doesn't list them.
const BUILTIN_IGNORES = [
  "node_modules",
  ".git",
  ".schematic",
  "dist",
  "build",
  "coverage",
  ".next",
  ".vite",
  ".turbo",
  ".cache",
];

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs",
  ".rb", ".php",
  ".md", ".json", ".yaml", ".yml", ".toml",
  ".html", ".css", ".scss", ".sass",
  ".sh", ".bash", ".zsh",
  ".sql", ".graphql",
]);

function languageForExt(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".ts": return "ts";
    case ".tsx": return "tsx";
    case ".js": case ".mjs": case ".cjs": return "js";
    case ".jsx": return "jsx";
    case ".py": return "py";
    case ".rs": return "rs";
    case ".go": return "go";
    case ".java": return "java";
    case ".md": return "md";
    case ".json": return "json";
    case ".yaml": case ".yml": return "yaml";
    case ".html": return "html";
    case ".css": return "css";
    case ".sh": case ".bash": case ".zsh": return "sh";
    default: return undefined;
  }
}

async function readIgnoreFile(root: string, filename: string): Promise<string | null> {
  try {
    return await readFile(join(root, filename), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function walkWorkspace(root: string): Promise<WalkedFile[]> {
  const ig = ignore();
  ig.add(BUILTIN_IGNORES);

  // Load .gitignore + .schematic-ignore at the root. (Nested .gitignores
  // aren't merged for v1; they're rare in monorepos we target.)
  const gitignore = await readIgnoreFile(root, ".gitignore");
  if (gitignore) ig.add(gitignore);
  const schematicIgnore = await readIgnoreFile(root, ".schematic-ignore");
  if (schematicIgnore) ig.add(schematicIgnore);

  const out: WalkedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute);
      // ignore() expects posix separators; on Unix this is already fine.
      const relPosix = rel.split("/").join("/");
      if (ig.ignores(relPosix) || (entry.isDirectory() && ig.ignores(relPosix + "/"))) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        // Skip files we don't understand (images, binaries). Keeping the
        // graph focused on code + text artifacts.
        if (!TEXT_EXTENSIONS.has(ext.toLowerCase())) continue;
        const s = await stat(absolute);
        out.push({
          absolutePath: absolute,
          relativePath: rel,
          byte_size: s.size,
          mtime_ms: s.mtimeMs,
          language: languageForExt(ext),
        });
      }
    }
  }

  await walk(root);
  return out;
}
