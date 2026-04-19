import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { CONFIG_PATH, SCHEMATIC_HOME, WORKSPACES_DIR } from "./paths.js";
import { atomicWrite } from "./atomic-write.js";

export interface SchematicConfig {
  port: number;
  ignored_paths: string[];
  welcome_shown: boolean;
  // Which workspace the browser should display on cold boot. Updated every
  // time POST /focus is called so daemon restarts don't drop the user's view.
  focused_workspace_id: string | null;
}

const DEFAULT_CONFIG: SchematicConfig = {
  port: 7777,
  ignored_paths: [],
  welcome_shown: false,
  focused_workspace_id: null,
};

export async function ensureSchematicHome(): Promise<void> {
  await mkdir(SCHEMATIC_HOME, { recursive: true });
  await mkdir(WORKSPACES_DIR, { recursive: true });
}

// Reads the config or initializes the default on first run.
// ENOENT is a LEGITIMATE fresh-install state, not a silent recovery:
// we explicitly write defaults so subsequent reads are fast and the file
// is inspectable by the user.
//
// On fresh install we probe 7777-7800 for a free port and save whichever
// we can bind. Avoids the common "port 7777 is already taken on my
// machine" problem without requiring the user to discover the config
// command.
export async function readOrInitConfig(): Promise<SchematicConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<SchematicConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await ensureSchematicHome();
    const chosenPort = await findFreePort(7777, 7800);
    const cfg: SchematicConfig = { ...DEFAULT_CONFIG, port: chosenPort };
    await atomicWrite(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}

// Port probe — binds briefly to see if the port is free. Scans a small
// range rather than letting the OS pick (port 0) because we want the
// port to stay stable across restarts and be predictable for the user.
async function findFreePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `[schematic] no free port in range ${start}-${end}. Close whatever is using these ports or set an explicit port: \`schematic config set port <N>\`.`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export async function writeConfig(cfg: SchematicConfig): Promise<void> {
  await ensureSchematicHome();
  await atomicWrite(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
