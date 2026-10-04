/**
 * Repairs holes in stored fills and recomputes the analytics built on them.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @trading-dashboard/api fills:repair [options]
 *
 * Watched addresses (active `leaders`): each is caught up from its verified
 * cursor, then backfilled backward window by window until the REST API's
 * retention start, the one-year floor or the fill cap; the stored span is
 * then checked for position breaks (each re-read) and the trader's
 * analytics are rebuilt from the verified span. What REST no longer holds
 * is reported as `partialSince`, never claimed.
 *
 * Other addresses of the tracked set whose analytics have no raw fills
 * behind them (computed before raw rows were kept): a history job over the
 * range they claim is created; `--untracked N` also runs N of them now.
 *
 * Options:
 *   --addresses a,b     only these watched addresses (default: all active)
 *   --weight N          REST weight limit per minute, at most 150 (default 150;
 *                       the sustained rate is N − 50, see HEADROOM)
 *   --max-windows N     backward windows per address this run (default 400)
 *   --max-fills N       stop an address's backfill once its span holds N fills (default 500000, BACKFILL_MAX_FILLS)
 *   --untracked N       unbacked untracked addresses to complete now (default 0)
 *   --untracked-addresses a,b   complete exactly these
 *   --dry-run           report what would be done; no REST call, no write
 *
 * Idempotent and resumable: progress is in `fill_coverage` /
 * `analysis_history_jobs`, fills are keyed by tid, and a second run only
 * reads what the first did not finish. Safe beside a running worker (every
 * span move is a compare-and-set). Never deletes a row.
 */
import "reflect-metadata";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";

import { storedTids } from "../traders/history-fill.store.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const list = (name: string) => option(name)?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);

export const MAX_REPAIR_WEIGHT_PER_MIN = 150;
/** The budgeter's bucket, and the room left under the limit for a full
 * page: a list call is admitted before its size is known and may take the
 * bucket 100 below zero, so the refill rate is set 50 under the limit.
 * Full pages (120 weight) are then at least 72 s apart and a rolling minute
 * stays at about the limit; the sustained rate is `weight − 50`. */
const BURST = 20;
const HEADROOM = 50;

export interface RepairOptions {
  addresses?: string[];
  weightPerMin: number;
  maxWindows: number;
  maxFills?: number;
  untracked: number;
  untrackedAddresses?: string[];
  dryRun: boolean;
  log?: (line: string) => void;
}

interface Span { from: string | null; through: string | null; status: string | null; fills: number; breaks: number }

export async function repairFills(options: RepairOptions) {
  const log = options.log ?? ((line: string) => console.log(line));
  const weight = Math.min(MAX_REPAIR_WEIGHT_PER_MIN, Math.max(HEADROOM + 10, options.weightPerMin));
  // The api's modules as an application context: no routes, and no watcher,
  // schedules or bot (those are only in AppModule.worker()).
  delete process.env.IS_WORKER;
  process.env.WORKER_URL ??= "http://127.0.0.1:9";
  process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = String(weight - HEADROOM);
  process.env.HYPERLIQUID_WEIGHT_BURST = String(BURST);
  const [{ AppModule }, { FillSyncService }, { TradeAnalyticsService }, { AnalysisHistoryService }, { AnalysisHistoryRepository }, { RequestBudgeterService, UNRANKED_BASE }, { DRIZZLE_CLIENT }] = await Promise.all([
    import("../app.module.js"), import("./fill-sync.service.js"), import("../traders/trade-analytics.service.js"), import("../traders/analysis-history.service.js"),
    import("../traders/analysis-history.repository.js"), import("../hyperliquid/request-budgeter.service.js"), import("../db/db.constants.js"),
  ]);
  const app = await NestFactory.createApplicationContext(AppModule.api(), { logger: ["error", "warn"] });
  try {
    const db = app.get<import("../db/drizzle.provider.js").DrizzleDb>(DRIZZLE_CLIENT, { strict: false });
    const fillSync = app.get(FillSyncService, { strict: false });
    const analytics = app.get(TradeAnalyticsService, { strict: false });
    const history = app.get(AnalysisHistoryService, { strict: false });
    const historyRepository = app.get(AnalysisHistoryRepository, { strict: false });
    const budgeter = app.get(RequestBudgeterService, { strict: false });
    const started = Date.now();
    let peak = 0;
    let spent = 0;
    const sample = () => { const now = budgeter.introspect().weightLastMinute; peak = Math.max(peak, now); return now; };
    // Weight actually sent: the trailing-minute window, summed once per minute of run time.
    const ticker = setInterval(() => { spent += sample(); }, 60_000);
    ticker.unref();

    // Behind every page request, and never through the page lane's limits.
    // A revision event may already have started a computation: let it end,
    // then compute once more from the final state.
    const recompute = async (address: string) => {
      for (let attempt = 0; ; attempt++) {
        await analytics.settled();
        try {
          return await analytics.compute(address, false, { rank: UNRANKED_BASE });
        } catch (error) {
          if (attempt >= 3) throw error;
        }
      }
    };

    const span = async (address: string): Promise<Span> => {
      const { rows: [row] } = await db.execute<{ verified_from: Date | null; verified_through: Date | null; backfill_status: string | null; fills: number; breaks: number }>(sql`
        SELECT c.verified_from, c.verified_through, c.backfill_status, coalesce(jsonb_array_length(c.breaks), 0)::int AS breaks,
          (SELECT count(*)::int FROM fills f WHERE f.address = ${address}) AS fills
        FROM (SELECT 1) one LEFT JOIN fill_coverage c ON c.address = ${address}`);
      return { from: row.verified_from ? new Date(row.verified_from).toISOString() : null, through: row.verified_through ? new Date(row.verified_through).toISOString() : null,
        status: row.backfill_status, fills: row.fills, breaks: row.breaks };
    };

    const watched = options.addresses ?? (await db.execute<{ address: string }>(sql`SELECT address FROM leaders WHERE active ORDER BY address`)).rows.map((row) => row.address);
    // The tracked set's untracked members whose figures no stored raw fill backs.
    const unbacked = (await db.execute<{ address: string; coverage_from: Date; fills_read: number; stored: number }>(sql`
      SELECT a.address, a.coverage_from, a.fills_read,
        ${storedTids(sql`a.address`, sql`a.coverage_from`, sql`a.fill_cursor`)} AS stored
      FROM trader_analytics a
      WHERE a.source = 'hyperliquid' AND a.history_through IS NULL AND a.coverage_from IS NOT NULL AND a.fill_cursor IS NOT NULL
        AND a.address NOT IN (SELECT address FROM leaders WHERE active)
        AND a.address IN (
          SELECT address FROM discovery_traders WHERE in_pool UNION SELECT address FROM kol_traders
          UNION SELECT address FROM user_favorites UNION SELECT address FROM cohort_members
          UNION SELECT address FROM leaders UNION SELECT leader_address FROM copy_strategies WHERE status <> 'stopped')
      ORDER BY a.fills_read`)).rows.filter((row) => row.stored < row.fills_read);
    log(`Watched addresses: ${watched.length}; untracked analytics without raw fills: ${unbacked.length} (${unbacked.reduce((sum, row) => sum + row.fills_read - row.stored, 0)} fills unbacked); limit ${weight} weight/min (sustained ${weight - HEADROOM})`);

    const report: { watched: unknown[]; untracked: unknown[] } = { watched: [], untracked: [] };
    for (const address of watched) {
      const before = await span(address);
      if (options.dryRun) { report.watched.push({ address, before }); log(`${address} ${JSON.stringify(before)}`); continue; }
      const entry: Record<string, unknown> = { address, before };
      try {
        let inserted = 0;
        for (let round = 0; round < 50; round++) {
          const result = await fillSync.catchUp(address);
          inserted += result.inserted;
          if (result.complete) break;
        }
        let windows = 0;
        let status = "pending";
        for (; windows < options.maxWindows && status === "pending"; windows++) {
          const step = await fillSync.backfillStep(address, undefined, options.maxFills);
          sample();
          inserted += step.inserted;
          status = step.status;
        }
        const continuity = await fillSync.checkContinuity(address, true);
        const row = await recompute(address);
        const after = await span(address);
        Object.assign(entry, { after, inserted, windows, continuity,
          // Complete from here on; anything earlier REST no longer returns (left to the archive).
          partialSince: after.status === "complete" ? null : after.from,
          analytics: { source: row.source, fills: row.fillsRead, from: row.coverageFrom, through: row.historyThrough, truncated: row.truncated } });
      } catch (error) {
        // The cursor did not move past what was read: the next run resumes here.
        entry.error = (error as Error).message;
        entry.after = await span(address);
      }
      // The budgeter halves its rate on a real 429 and recovers slowly: visible here.
      entry.budget = { effectivePerMin: budgeter.introspect().effectiveBudgetPerMin, minutes: Math.round((Date.now() - started) / 6_000) / 10 };
      report.watched.push(entry);
      log(`${address} ${JSON.stringify({ ...entry, address: undefined })}`);
    }

    const chosen = options.untrackedAddresses ? unbacked.filter((row) => options.untrackedAddresses!.includes(row.address)) : unbacked.slice(0, options.untracked);
    for (const row of unbacked) {
      const entry: Record<string, unknown> = { address: row.address, claimedFrom: row.coverage_from, fillsClaimed: row.fills_read, fillsStored: row.stored };
      if (!options.dryRun) {
        // Durable: the worker's history job completes it even if this run does not.
        await history.ensure(row.address, new Date(row.coverage_from).getTime());
        if (chosen.includes(row)) {
          try {
            for (let round = 0; round < 500; round++) {
              const job = await historyRepository.state(row.address);
              if (!job || job.status !== "pending") break;
              if ((await history.advance(job, Date.now(), 2)) === 0 && (await historyRepository.state(row.address))?.version === job.version) break;
            }
            const job = await historyRepository.state(row.address);
            const refreshed = await recompute(row.address);
            // Raw-backed only when the rebuild came from the stored history.
            Object.assign(entry, { job: job?.status, analytics: { fills: refreshed.fillsRead, from: refreshed.coverageFrom, through: refreshed.historyThrough },
              backed: refreshed.historyThrough !== null, unrecoverableBefore: refreshed.historyThrough === null ? "REST no longer returns the start of the claimed range" : null });
          } catch (error) {
            entry.error = (error as Error).message;
          }
          log(`${row.address} ${JSON.stringify({ ...entry, address: undefined })}`);
        } else {
          entry.job = "queued";
        }
      }
      report.untracked.push(entry);
    }
    await analytics.settled();
    spent += sample();
    const summary = { minutes: Math.round((Date.now() - started) / 6_000) / 10, weightApprox: spent, peakWeightPerMinute: peak, pace: weight };
    log(JSON.stringify(summary));
    clearInterval(ticker);
    return { ...report, summary };
  } finally {
    await app.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const envFile = resolve(import.meta.dirname, "../../../../.env");
  // An explicit DATABASE_URL (the shell's) wins over the repo's .env.
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  repairFills({
    addresses: list("addresses"),
    weightPerMin: Number(option("weight") ?? MAX_REPAIR_WEIGHT_PER_MIN),
    maxWindows: Number(option("max-windows") ?? 400),
    maxFills: option("max-fills") ? Number(option("max-fills")) : undefined,
    untracked: Number(option("untracked") ?? 0),
    untrackedAddresses: list("untracked-addresses"),
    dryRun: args.includes("--dry-run"),
  }).then(() => process.exit(0)).catch((error: Error) => {
    console.error(`Repair failed: ${error.message}`);
    process.exit(1);
  });
}
