import { readFile, mkdir } from "node:fs/promises";
import { CONFIG_PATH, SCHEMATIC_HOME, WORKSPACES_DIR } from "./paths.js";
import { atomicWrite } from "./atomic-write.js";

export interface SchematicConfig {
  port: number;
  ignored_paths: string[];
  welcome_shown: boolean;
}

const DEFAULT_CONFIG: SchematicConfig = {
  port: 7777,
  ignored_paths: [],
  welcome_shown: false,
};

export async function ensureSchematicHome(): Promise<void> {
  await mkdir(SCHEMATIC_HOME, { recursive: true });
  await mkdir(WORKSPACES_DIR, { recursive: true });
}

// Reads the config or initializes the default on first run.
// ENOENT is a LEGITIMATE fresh-install state, not a silent recovery:
// we explicitly write defaults so subsequent reads are fast and the file
// is inspectable by the user.
export async function readOrInitConfig(): Promise<SchematicConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<SchematicConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await ensureSchematicHome();
    const cfg: SchematicConfig = { ...DEFAULT_CONFIG };
    await atomicWrite(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}

export async function writeConfig(cfg: SchematicConfig): Promise<void> {
  await ensureSchematicHome();
  await atomicWrite(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
