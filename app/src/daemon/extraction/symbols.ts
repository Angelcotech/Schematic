// Exported-symbol extractor. For each TS/TSX/JS/JSX source file we walk
// the AST once and emit the top-level exports: functions, classes,
// interfaces, types, enums, and exported consts. Internal helpers are
// skipped so tier-3 doesn't drown in implementation detail.
//
// Output is flat (not yet positioned) — layout.ts places symbols inside
// their parent file's rectangle.

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ts from "typescript";
import type { SymbolKind } from "../../shared/node-state.js";
import type { WalkedFile } from "./walker.js";

export interface ExtractedSymbol {
  file_id: string;         // workspace-relative path of the containing file
  name: string;
  kind: SymbolKind;
  signature?: string;
}

const PARSEABLE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function parseSymbols(file: WalkedFile): Promise<ExtractedSymbol[]> {
  if (!PARSEABLE.has(extname(file.absolutePath).toLowerCase())) return [];

  let source: string;
  try {
    source = await readFile(file.absolutePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const sf = ts.createSourceFile(file.absolutePath, source, ts.ScriptTarget.Latest, true);
  const out: ExtractedSymbol[] = [];

  const push = (name: string, kind: SymbolKind, signature?: string): void => {
    const symbol: ExtractedSymbol = { file_id: file.relativePath, name, kind };
    if (signature !== undefined) symbol.signature = signature;
    out.push(symbol);
  };

  for (const statement of sf.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (!isExported && !isDefault) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      push(statement.name.text, "function", buildFunctionSignature(statement));
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      push(statement.name.text, "class");
    } else if (ts.isInterfaceDeclaration(statement)) {
      push(statement.name.text, "interface");
    } else if (ts.isTypeAliasDeclaration(statement)) {
      push(statement.name.text, "type");
    } else if (ts.isEnumDeclaration(statement)) {
      push(statement.name.text, "constant");
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          // Treat arrow-function consts as functions, everything else as constant.
          const initKind = decl.initializer?.kind;
          const isArrow =
            initKind === ts.SyntaxKind.ArrowFunction ||
            initKind === ts.SyntaxKind.FunctionExpression;
          push(decl.name.text, isArrow ? "function" : "constant");
        }
      }
    }
    // Non-default `export default function Foo() {}` is covered above via
    // isFunctionDeclaration. Anonymous `export default` values are skipped —
    // they carry no meaningful symbol name for a graph.
  }

  return out;
}

function buildFunctionSignature(fn: ts.FunctionDeclaration): string {
  // Keep signatures terse — name already shows, so just show params + return.
  const params = fn.parameters
    .map((p) => {
      const name = p.name.getText();
      const type = p.type ? `: ${p.type.getText()}` : "";
      return `${name}${type}`;
    })
    .join(", ");
  const ret = fn.type ? `: ${fn.type.getText()}` : "";
  return `(${params})${ret}`;
}
