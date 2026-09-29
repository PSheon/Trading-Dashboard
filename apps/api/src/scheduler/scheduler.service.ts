import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { and, eq } from "drizzle-orm";
import {
  CHAIN_DEFAULT,
  equitySnapshots,
  leaders,
  positionSnapshots,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { HlClearinghouseStateResponse } from "../hyperliquid/types.js";
import { WatcherService } from "../watcher/watcher.service.js";

/**
 * Downsampled snapshot persistence (W4, adapted for polling-only §4.2/§11:
 * "儲存維持 5 分鐘一筆；詳情頁預設每小時一點，可切 5 分鐘 — 儲存不降採樣，顯示
 * 才降"). The fast Watcher poll loop runs every
 * `WATCHER_POLL_INTERVAL_SECONDS` (tens of seconds) for fill/action
 * detection; this cron reuses whatever clearinghouseState the poll loop
 * most recently cached for each active leader and writes it down at a
 * fixed 5-minute grain — no second round of API calls, per the task's
 * explicit instruction (that would double the request budget for no
 * benefit, since positions don't need finer-than-5-minute storage).
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly watcher: WatcherService,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async pollAllLeaders(): Promise<void> {
    const activeLeaders = await this.db
      .select({ address: leaders.address })
      .from(leaders)
      .where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.active, true)));

    const cached = this.watcher.getCachedStates();
    let written = 0;
    let skipped = 0;

    for (const { address } of activeLeaders) {
      const entry = cached.get(address);
      if (!entry) {
        // Address hasn't completed a single fast-poll cycle yet (just
        // imported, or the Watcher only just started) — nothing to
        // snapshot this round, the next 5-minute tick will have it.
        skipped += 1;
        continue;
      }

      try {
        await this.writeSnapshots(address, entry.response, entry.fetchedAt);
        written += 1;
      } catch (error) {
        this.logger.error(
          `Snapshot write failed for ${address}: ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(`5-min snapshot tick: wrote ${written}, skipped ${skipped} (no cached state yet)`);
  }

  private async writeSnapshots(
    address: string,
    response: HlClearinghouseStateResponse,
    ts: Date,
  ): Promise<void> {
    await this.db
      .insert(equitySnapshots)
      .values({
        chain: CHAIN_DEFAULT,
        address,
        ts,
        accountValue: response.marginSummary.accountValue,
        totalMarginUsed: response.marginSummary.totalMarginUsed,
        withdrawable: response.withdrawable,
      })
      .onConflictDoNothing();

    const positionRows = response.assetPositions
      .filter((ap) => Number(ap.position.szi) !== 0)
      .map((ap) => ({
        chain: CHAIN_DEFAULT,
        address,
        coin: ap.position.coin,
        ts,
        szi: ap.position.szi,
        entryPx: ap.position.entryPx ?? null,
        leverage: ap.position.leverage?.value?.toString() ?? null,
        marginMode: ap.position.leverage?.type ?? null,
        unrealizedPnl: ap.position.unrealizedPnl,
        liqPx: ap.position.liquidationPx ?? null,
      }));

    if (positionRows.length > 0) {
      await this.db.insert(positionSnapshots).values(positionRows).onConflictDoNothing();
    }
  }

  /** Refreshes coin_meta from `meta()` (szDecimals, max leverage). Out of
   * scope for this task (not part of the budgeter/Watcher/leader-pool/
   * heartbeat items) — left as the scaffold's not-implemented stub. */
  async refreshCoinMeta(): Promise<void> {
    throw new Error("not implemented");
  }

  /** N3: records mid price 1h/4h/24h after a sent alert. Out of scope
   * (Notify/Rules territory, M2). */
  async scoreAlert(_alertId: bigint): Promise<void> {
    throw new Error("not implemented");
  }
}
