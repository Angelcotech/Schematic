import { readOrInitConfig, writeConfig, type SchematicConfig } from "../../daemon/persist/config.js";

export async function configGet(key?: string): Promise<void> {
  const cfg = await readOrInitConfig();
  if (!key) {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }
  if (!(key in cfg)) throw new Error(`[schematic] unknown config key: ${key}`);
  console.log(JSON.stringify(cfg[key as keyof SchematicConfig]));
}

export async function configSet(key: string, value: string): Promise<void> {
  const cfg = await readOrInitConfig();
  if (!(key in cfg)) throw new Error(`[schematic] unknown config key: ${key}`);

  // Coerce value based on existing type. Hardwired per Law 1 — explicit type per key.
  const next: SchematicConfig = { ...cfg };
  switch (key) {
    case "port":
      next.port = Number.parseInt(value, 10);
      if (!Number.isInteger(next.port) || next.port <= 0 || next.port > 65535) {
        throw new Error(`[schematic] invalid port: ${value}`);
      }
      break;
    case "welcome_shown":
      next.welcome_shown = value === "true";
      break;
    case "ignored_paths":
      next.ignored_paths = value.split(",").map((p) => p.trim()).filter(Boolean);
      break;
    default:
      throw new Error(`[schematic] config set not implemented for key: ${key}`);
  }

  await writeConfig(next);
  console.log(`✔ config.${key} = ${JSON.stringify(next[key as keyof SchematicConfig])}`);
}
