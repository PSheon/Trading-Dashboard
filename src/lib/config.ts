import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Settings {
  heliusApiKey: string | null;
  duneApiKey: string | null;
  dataDir: string;
}

// Minimal .env reader: KEY=value lines, no expansion. Real environment wins.
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function loadSettings(root: string = process.cwd()): Settings {
  loadDotEnv(path.join(root, ".env"));
  return {
    heliusApiKey: process.env.HELIUS_API_KEY || null,
    duneApiKey: process.env.DUNE_API_KEY || null,
    dataDir: process.env.DATA_DIR || path.join(root, "data"),
  };
}

export function requireSetting(value: string | null, name: string): string {
  if (!value) throw new Error(`${name} is not set; add it to .env (see .env.example)`);
  return value;
}
