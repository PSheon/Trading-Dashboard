import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { and, eq, max, ne, sql } from "drizzle-orm";
import { CHAIN_DEFAULT, traderStats } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { SettingsService } from "../settings/settings.service.js";
import {
  chunk,
  LEADERBOARD_URL,
  parseLeaderboard,
  parseVaults,
  UPSERT_CHUNK_ROWS,
  VAULTS_URL,
  type TraderStatsInsert,
} from "./leaderboard.js";

/** The payloads are ≈38 MB and ≈14 MB; allow a slow link, never hang. */
const FETCH_TIMEOUT_MS = 120_000;

export interface IngestResult {
  rows: number;
  removed: number;
  /** Rows flagged as vaults; null when the vault list couldn't be fetched
   * and the previous flags were kept. */
  vaults: number | null;
  fetchMs: number;
  writeMs: number;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Imports Hyperliquid's official leaderboard into `trader_stats` (Stage 2
 * §4) whenever it is older than `discovery.leaderboardRefreshMinutes`,
 * checked every minute and at startup, so a changed setting applies without
 * a restart. Vaults are flagged from Hyperliquid's vault list (§10,
 * 競品分析 §3.9).
 *
 * Each import replaces the table: all rows are upserted with one shared
 * `updated_at`, then rows this import didn't include are deleted, inside one
 * transaction, so readers see either the previous table or the new one.
 * If the vault list fails, the previous `is_vault` flags are kept. The stats
 * host is not the info API, so this costs no REST weight.
 */
@Injectable()
export class LeaderboardIngestService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeaderboardIngestService.name);
  private running: Promise<IngestResult> | undefined;
  private vaults: { addresses: Set<string>; fetchedAt: Date } | undefined;
  private startupDone!: () => void;
  /** Resolves once the startup import (or vault-list load) has finished,
   * successfully or not; the home warmer waits for it. */
  readonly startup = new Promise<void>((resolve) => (this.startupDone = resolve));

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly settings: SettingsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return this.startupDone();
    this.bootstrap()
      .catch((error: unknown) => this.logger.error(`Startup leaderboard import failed: ${(error as Error).message}`))
      .finally(() => this.startupDone());
  }

  private async bootstrap(): Promise<void> {
    // A fresh table skips the import, but profiles still need the vault set.
    if (!(await this.refreshIfStale())) await this.loadVaults();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async onTick(): Promise<void> {
    try {
      await this.refreshIfStale();
    } catch (error) {
      this.logger.error(`Leaderboard import failed: ${(error as Error).message}`);
    }
  }

  /** Whether `address` is in the last vault list fetched (false before any). */
  isVault(address: string): boolean {
    return this.vaults?.addresses.has(address) ?? false;
  }

  /** When the last import landed, or null if the table is empty. */
  async lastImportAt(): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: max(traderStats.updatedAt) })
      .from(traderStats)
      .where(eq(traderStats.chain, CHAIN_DEFAULT));
    return row?.at ?? null;
  }

  async refreshIntervalMs(): Promise<number> {
    return (await this.settings.get("discovery")).leaderboardRefreshMinutes * 60_000;
  }

  /** Imports if the table is empty or older than the configured interval. */
  async refreshIfStale(now = Date.now()): Promise<IngestResult | null> {
    const [last, interval] = await Promise.all([this.lastImportAt(), this.refreshIntervalMs()]);
    if (last && now - last.getTime() < interval) return null;
    return this.refresh();
  }

  /** Fetches and imports; concurrent callers share one run. */
  refresh(): Promise<IngestResult> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Fetches the vault list and replaces the in-memory set. */
  async loadVaults(): Promise<Set<string>> {
    const addresses = parseVaults(await fetchJson(VAULTS_URL));
    this.vaults = { addresses, fetchedAt: new Date() };
    return addresses;
  }

  private async run(): Promise<IngestResult> {
    const started = Date.now();
    const [board, vaultList] = await Promise.allSettled([fetchJson(LEADERBOARD_URL), this.loadVaults()]);
    if (board.status === "rejected") throw board.reason;
    const fetchMs = Date.now() - started;
    let vaults: Set<string> | null = null;
    if (vaultList.status === "fulfilled") vaults = vaultList.value;
    else this.logger.warn(`Vault list failed, keeping previous vault flags: ${(vaultList.reason as Error).message}`);

    const importedAt = new Date();
    // Without a fresh list, new rows use the last list this process fetched;
    // existing rows keep their flags (updateVaultFlags = false).
    const rows = parseLeaderboard(board.value, importedAt, vaults ?? this.vaults?.addresses);
    const writeStarted = Date.now();
    const removed = await this.replaceAll(rows, importedAt, vaults !== null);
    const result: IngestResult = {
      rows: rows.length,
      removed,
      vaults: vaults ? rows.filter((r) => r.isVault).length : null,
      fetchMs,
      writeMs: Date.now() - writeStarted,
    };
    this.logger.log(
      `Leaderboard imported: ${result.rows} rows, ${result.removed} removed, ${result.vaults ?? "unchanged"} vaults ` +
        `(fetch ${fetchMs} ms, write ${result.writeMs} ms)`,
    );
    return result;
  }

  /**
   * Upserts `rows` (all stamped `importedAt`) in chunks and deletes every
   * other row, in one transaction. Returns how many rows were removed.
   * With `updateVaultFlags` false, existing rows keep their `is_vault` (new
   * rows take the value in `rows`). Refuses an empty import rather than
   * wiping the table.
   */
  async replaceAll(rows: TraderStatsInsert[], importedAt: Date, updateVaultFlags = true): Promise<number> {
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
              ...(updateVaultFlags ? { isVault: sql`excluded.is_vault` } : {}),
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
