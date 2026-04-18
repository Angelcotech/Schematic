// Serves the bundled frontend (app/dist/web/) over the same HTTP server
// the API lives on. Falls back to index.html for unmatched paths so the
// frontend can own client-side routing.
//
// Resolution is done relative to this file (via import.meta.url) so the
// daemon finds web/ regardless of where it was installed (npm global,
// local clone, `npm pack` tarball).

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

// In the built layout this file lives at `app/dist/daemon/static-web.js`,
// and the bundled web assets are at `app/dist/web/`.
const here = fileURLToPath(import.meta.url);
const WEB_ROOT = resolve(here, "..", "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export async function webAssetsExist(): Promise<boolean> {
  try {
    await stat(join(WEB_ROOT, "index.html"));
    return true;
  } catch {
    return false;
  }
}

// Returns true if it handled the request, false if it didn't match and
// the caller should continue routing.
export async function tryServeStatic(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;

  // Resolve + normalize to block any `..` path-traversal attempts.
  const candidatePath = normalize(join(WEB_ROOT, requested));
  if (!candidatePath.startsWith(WEB_ROOT)) return false;

  let fileToServe = candidatePath;
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(fileToServe);
    if (st.isDirectory()) {
      fileToServe = join(fileToServe, "index.html");
      st = await stat(fileToServe);
    }
  } catch {
    // SPA fallback: if the path looks like a client route (no extension),
    // serve index.html so the frontend can handle it. If it clearly
    // points at a missing asset (has an extension), let the caller 404.
    if (extname(requested) !== "") return false;
    try {
      fileToServe = join(WEB_ROOT, "index.html");
      st = await stat(fileToServe);
    } catch {
      return false;
    }
  }

  const body = await readFile(fileToServe);
  const mime = MIME[extname(fileToServe).toLowerCase()] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", body.byteLength.toString());
  // Cache immutable hashed assets aggressively; index.html always fresh.
  if (extname(fileToServe) === ".html") {
    res.setHeader("Cache-Control", "no-cache");
  } else {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
  return true;
}

export { WEB_ROOT };
