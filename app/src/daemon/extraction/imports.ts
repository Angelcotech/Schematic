// File-level import parser. Uses the TypeScript compiler API to tokenize
// source files — correctly handles TS syntax (`import type`, `import =`,
// `export *`, dynamic `import()`), plain ES modules, JSX/TSX.
//
// For each file we extract the list of module specifiers it imports, then
// resolve them (relative paths only for v1) to repo-relative node IDs.

import { readFile } from "node:fs/promises";
import { dirname, resolve, extname } from "node:path";
import ts from "typescript";
import type { EdgeKind } from "../../shared/edge.js";
import type { WalkedFile } from "./walker.js";

export interface FileImport {
  specifier: string;
  kind: EdgeKind;
  // Resolved to a workspace-relative file path, or null if the target is
  // external (node module, absolute path outside workspace, unresolvable).
  resolvedNodeId: string | null;
}

// Only parse files TypeScript can understand without tsconfig acrobatics.
const PARSEABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function parseImports(file: WalkedFile): Promise<FileImport[]> {
  if (!PARSEABLE_EXTS.has(extname(file.absolutePath).toLowerCase())) return [];

  let source: string;
  try {
    source = await readFile(file.absolutePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const sf = ts.createSourceFile(file.absolutePath, source, ts.ScriptTarget.Latest, true);
  const specifiers: { specifier: string; kind: EdgeKind }[] = [];

  const walk = (node: ts.Node): void => {
    // `import ... from 'x'`  and  `import 'x'` (side-effect)
    if (ts.isImportDeclaration(node)) {
      const raw = node.moduleSpecifier;
      if (ts.isStringLiteral(raw)) {
        const typeOnly = node.importClause?.isTypeOnly === true;
        const sideEffect = !node.importClause; // no clause = `import 'x'`
        specifiers.push({
          specifier: raw.text,
          kind: typeOnly ? "type_only" : sideEffect ? "side_effect" : "import",
        });
      }
    }
    // `export ... from 'x'`
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({
        specifier: node.moduleSpecifier.text,
        kind: node.isTypeOnly ? "type_only" : "import",
      });
    }
    // `import x = require('x')`
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const ref = node.moduleReference.expression;
      if (ts.isStringLiteral(ref)) {
        specifiers.push({ specifier: ref.text, kind: "import" });
      }
    }
    // dynamic `import('x')` and `require('x')`
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          specifiers.push({ specifier: arg.text, kind: "dynamic_import" });
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          specifiers.push({ specifier: arg.text, kind: "import" });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  return specifiers.map((s) => ({
    ...s,
    resolvedNodeId: resolveSpecifier(file, s.specifier),
  }));
}

// Resolve a specifier against a file's directory. Only handles relative
// paths for v1; bare specifiers (`react`, `@scope/x`) and absolute paths
// return null and get filtered out by the caller.
// Returns the raw absolute path (possibly extensionless); the `linkImports`
// pass below probes file-system extensions against the known workspace set.
function resolveSpecifier(from: WalkedFile, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return resolve(dirname(from.absolutePath), specifier);
}

// Given the full walked-file set, turn the raw resolved absolute paths into
// valid node IDs by finding a matching file in the set. Unmatched = external.
//
// Handles the TypeScript convention of importing `./foo.js` to reach `foo.ts`:
// we try the specifier verbatim first, then strip `.js`/`.mjs`/`.cjs`/`.jsx`
// and retry with TS source extensions + index fallbacks.
export function linkImports(
  allFiles: Map<string, WalkedFile>, // key = absolute path
  perFile: Map<WalkedFile, FileImport[]>,
): Map<WalkedFile, FileImport[]> {
  const extensionCandidates = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  const indexCandidates = [
    "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs",
  ];

  // If the specifier already ends with a module extension, generate variants
  // that substitute it with TS source extensions.
  function bases(absolute: string): string[] {
    const jsExts = [".js", ".mjs", ".cjs", ".jsx"];
    for (const js of jsExts) {
      if (absolute.endsWith(js)) {
        const stripped = absolute.slice(0, -js.length);
        // Try verbatim first (a real .js file), then the TS source twins.
        return [absolute, `${stripped}.ts`, `${stripped}.tsx`, stripped];
      }
    }
    return [absolute];
  }

  const resolved = new Map<WalkedFile, FileImport[]>();
  for (const [file, imports] of perFile.entries()) {
    const out: FileImport[] = [];
    for (const imp of imports) {
      if (!imp.resolvedNodeId) {
        out.push(imp);
        continue;
      }
      let matched: string | null = null;
      outer:
      for (const base of bases(imp.resolvedNodeId)) {
        for (const suffix of extensionCandidates) {
          const target = allFiles.get(base + suffix);
          if (target) { matched = target.relativePath; break outer; }
        }
        for (const suffix of indexCandidates) {
          const target = allFiles.get(base + suffix);
          if (target) { matched = target.relativePath; break outer; }
        }
      }
      out.push({ ...imp, resolvedNodeId: matched });
    }
    resolved.set(file, out);
  }
  return resolved;
}
