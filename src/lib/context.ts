// Paths and clients shared by the CLI and the web server.

import path from "node:path";

import { loadSettings, requireSetting, type Settings } from "./config";
import { HeliusClient } from "./helius";
import { Notes } from "./notes";
import { Warehouse } from "./store";

export interface Context {
  settings: Settings;
  wh: Warehouse;
  rawDir: string;
  notesFile: string;
  helius: () => HeliusClient;
}

export function context(settings: Settings = loadSettings()): Context {
  return {
    settings,
    wh: new Warehouse(path.join(settings.dataDir, "warehouse")),
    rawDir: path.join(settings.dataDir, "raw"),
    notesFile: path.join(settings.dataDir, "manual.sqlite"),
    helius: () => new HeliusClient(requireSetting(settings.heliusApiKey, "HELIUS_API_KEY")),
  };
}

export function notesFor(ctx: Context): Notes {
  return new Notes(ctx.notesFile);
}
