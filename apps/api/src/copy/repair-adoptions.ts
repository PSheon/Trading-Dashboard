/**
 * Re-runs adoption (跟單目前持倉) for active paper copies that started
 * without the leader's positions because market data failed to load.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @trading-dashboard/api copy:repair-adoptions [options]
 *
 * Options:
 *   --strategy N   only this strategy (default: every active strategy)
 *   --dry-run      report what would be ordered; no write
 *
 * Reads clearinghouseState (weight 2) per leader, allMids (2) and
 * metaAndAssetCtxs (20). Writes at most one `adopt` order per
 * (strategy, coin), with its own dedupe key; the running worker fills it.
 * Idempotent: see CopyAdoptionRepairService. Prints one JSON line per
 * candidate.
 */
import "reflect-metadata";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";

export async function repairAdoptions(options: { dryRun: boolean; strategyId?: number; log?: (line: string) => void }) {
  const log = options.log ?? ((line: string) => console.log(line));
  // No watcher, schedules, copy worker or bot in this process: only the services.
  process.env.APP_ROLE = "api";
  process.env.WORKER_URL ??= "http://127.0.0.1:9";
  const [{ AppModule }, { CopyAdoptionRepairService }] = await Promise.all([import("../app.module.js"), import("./copy-adoption-repair.service.js")]);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const items = await app.get(CopyAdoptionRepairService, { strict: false }).repair({ dryRun: options.dryRun, strategyId: options.strategyId });
    for (const item of items) log(JSON.stringify(item));
    log(JSON.stringify({ candidates: items.length, ordered: items.filter((i) => i.outcome === "ordered").length, dryRun: options.dryRun }));
    return items;
  } finally {
    await app.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const strategy = args.indexOf("--strategy") >= 0 ? Number(args[args.indexOf("--strategy") + 1]) : undefined;
  const envFile = resolve(import.meta.dirname, "../../../../.env");
  // An explicit DATABASE_URL (the shell's) wins over the repo's .env.
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  if (strategy !== undefined && !(Number.isInteger(strategy) && strategy > 0)) {
    console.error("--strategy needs a strategy id");
    process.exit(1);
  }
  repairAdoptions({ dryRun: args.includes("--dry-run"), strategyId: strategy }).then(() => process.exit(0)).catch((error: Error) => {
    console.error(`Adoption repair failed: ${error.message}`);
    process.exit(1);
  });
}
