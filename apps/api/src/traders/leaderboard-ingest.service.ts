import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { and, eq, max, ne, sql } from "drizzle-orm";
import { CHAIN_DEFAULT, traderStats } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import {
  chunk,
  LEADERBOARD_URL,
  parseLeaderboard,
  UPSERT_CHUNK_ROWS,
  type TraderStatsInsert,
} from "./leaderboard.js";

export const LEADERBOARD_REFRESH_MS = 15 * 60_000;
/** The payload is ≈38 MB; allow a slow link, but never hang forever. */
const FETCH_TIMEOUT_MS = 120_000;

export interface IngestResult {
  rows: number;
  removed: number;
  fetchMs: number;
  writeMs: number;
}

/**
 * Imports Hyperliquid's official leaderboard into `trader_stats` (Stage 2
 * §4): every 15 minutes, and at startup when the table is empty or stale.
 *
 * Each import replaces the table: all rows are upserted with one shared
 * `updated_at`, then rows this import didn't include are deleted, inside one
 * transaction, so readers see either the previous table or the new one.
 * The stats host is not the info API, so this costs no REST weight.
 */
@Injectable()
export class LeaderboardIngestService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeaderboardIngestService.name);
  private running: Promise<IngestResult> | undefined;

  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.refreshIfStale().catch((error: unknown) =>
      this.logger.error(`Startup leaderboard import failed: ${(error as Error).message}`),
    );
  }

  @Cron("0 */15 * * * *")
  async onSchedule(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      this.logger.error(`Leaderboard import failed: ${(error as Error).message}`);
    }
  }

  /** When the last import landed, or null if the table is empty. */
  async lastImportAt(): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: max(traderStats.updatedAt) })
      .from(traderStats)
      .where(eq(traderStats.chain, CHAIN_DEFAULT));
    return row?.at ?? null;
  }

  async refreshIfStale(now = Date.now()): Promise<IngestResult | null> {
    const last = await this.lastImportAt();
    if (last && now - last.getTime() < LEADERBOARD_REFRESH_MS) return null;
    return this.refresh();
  }

  /** Fetches and imports; concurrent callers share one run. */
  refresh(): Promise<IngestResult> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<IngestResult> {
    const started = Date.now();
    const res = await fetch(LEADERBOARD_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Leaderboard fetch failed: HTTP ${res.status}`);
    const payload: unknown = await res.json();
    const fetchMs = Date.now() - started;

    const importedAt = new Date();
    const rows = parseLeaderboard(payload, importedAt);
    const writeStarted = Date.now();
    const removed = await this.replaceAll(rows, importedAt);
    const result = { rows: rows.length, removed, fetchMs, writeMs: Date.now() - writeStarted };
    this.logger.log(
      `Leaderboard imported: ${result.rows} rows, ${result.removed} removed (fetch ${fetchMs} ms, write ${result.writeMs} ms)`,
    );
    return result;
  }

  /**
   * Upserts `rows` (all stamped `importedAt`) in chunks and deletes every
   * other row, in one transaction. Returns how many rows were removed.
   * Refuses an empty import rather than wiping the table.
   */
  async replaceAll(rows: TraderStatsInsert[], importedAt: Date): Promise<number> {
    if (rows.length === 0) throw new Error("Leaderboard import has no rows; keeping the current table");
    return this.db.transaction(async (tx) => {
      for (const part of chunk(rows, UPSERT_CHUNK_ROWS)) {
        await tx
          .insert(traderStats)
          .values(part)
          .onConflictDoUpdate({
            target: [traderStats.chain, traderStats.address],
            set: {
              displayName: sql`excluded.display_name`,
              accountValue: sql`excluded.account_value`,
              pnlDay: sql`excluded.pnl_day`,
              pnlWeek: sql`excluded.pnl_week`,
              pnlMonth: sql`excluded.pnl_month`,
              pnlAllTime: sql`excluded.pnl_all_time`,
              roiDay: sql`excluded.roi_day`,
              roiWeek: sql`excluded.roi_week`,
              roiMonth: sql`excluded.roi_month`,
              roiAllTime: sql`excluded.roi_all_time`,
              volumeDay: sql`excluded.volume_day`,
              volumeWeek: sql`excluded.volume_week`,
              volumeMonth: sql`excluded.volume_month`,
              volumeAllTime: sql`excluded.volume_all_time`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }
      const removed = await tx
        .delete(traderStats)
        .where(and(eq(traderStats.chain, CHAIN_DEFAULT), ne(traderStats.updatedAt, importedAt)))
        .returning({ address: traderStats.address });
      return removed.length;
    });
  }
}
