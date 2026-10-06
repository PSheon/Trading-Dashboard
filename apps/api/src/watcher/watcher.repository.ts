import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { copyLiveStrategyConfigs, copyStrategies, leaders } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { LIVE_STRATEGY_STATUSES } from "../copy/copy-outbox.js";

/** Read watch eligibility; subscriptions, sweeps and lifecycle belong to WatcherService. */
@Injectable()
export class WatcherRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Read active addresses on the configured chain without caching their eligibility. */
  async activeAddresses(): Promise<string[]> {
    const rows = await this.db
      .select({ address: leaders.address })
      .from(leaders)
      .where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.active, true)));
    return rows.map((r) => r.address);
  }

  /** Leaders a live copy follows (as `FillSyncRepository.isCopied`): every
   * one (`copied`), and those a testnet copy follows on mainnet (`mainnet`). */
  async copiedAddresses(): Promise<{ copied: Set<string>; mainnet: Set<string> }> {
    const rows = await this.db
      .select({ address: copyStrategies.leaderAddress, mode: copyStrategies.mode, network: copyLiveStrategyConfigs.sourceNetwork })
      .from(copyStrategies)
      .leftJoin(copyLiveStrategyConfigs, eq(copyLiveStrategyConfigs.strategyId, copyStrategies.id))
      .where(and(eq(copyStrategies.chain, CHAIN_DEFAULT), inArray(copyStrategies.status, [...LIVE_STRATEGY_STATUSES]),
        sql`(${copyStrategies.mode} = 'paper' or ${copyLiveStrategyConfigs.sourceNetwork} = 'mainnet')`));
    return {
      copied: new Set(rows.map((r) => r.address)),
      mainnet: new Set(rows.filter((r) => r.mode !== "paper" && r.network === "mainnet").map((r) => r.address)),
    };
  }
}
