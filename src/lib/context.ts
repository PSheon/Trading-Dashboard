// Paths and clients shared by the CLI and the web server.

import path from "node:path";

import { loadSettings, requireSetting, type Settings } from "./config";
import { DuneClient } from "./dune";
import { DEFAULT_CREDIT_BUDGET } from "./jobs";
import { HeliusClient } from "./helius";
import { Notes } from "./notes";
import { Warehouse } from "./store";

export interface Context {
  settings: Settings;
  wh: Warehouse;
  rawDir: string;
  notesFile: string;
  creditBudget: number;
  helius: () => HeliusClient;
  /** Null without DUNE_API_KEY: the token table then just stays as it is. */
  dune: () => DuneClient | null;
}

export function context(settings: Settings = loadSettings()): Context {
  const budget = Number(process.env.CREDIT_BUDGET_PER_RUN);
  return {
    settings,
    wh: new Warehouse(path.join(settings.dataDir, "warehouse")),
    rawDir: path.join(settings.dataDir, "raw"),
    notesFile: path.join(settings.dataDir, "manual.sqlite"),
    creditBudget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_CREDIT_BUDGET,
    helius: () => new HeliusClient(requireSetting(settings.heliusApiKey, "HELIUS_API_KEY")),
    dune: () => (settings.duneApiKey ? new DuneClient(settings.duneApiKey) : null),
  };
}

export function notesFor(ctx: Context): Notes {
  return new Notes(ctx.notesFile);
}
