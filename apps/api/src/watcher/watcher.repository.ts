import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { copyStrategies, leaders } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { LIVE_STRATEGY_STATUSES } from "../copy/copy-outbox.js";
import { AppConfig } from "../config/app-config.js";
import { deploymentNetwork } from "../copy/live-deployment.js";
import { copySourceEligibility } from "./copy-source-eligibility.js";

/** Read watch eligibility; subscriptions, sweeps and lifecycle belong to WatcherService. */
@Injectable()
export class WatcherRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly config: AppConfig) {}

  /** Read active addresses on the configured chain without caching their eligibility. */
  async activeAddresses(): Promise<string[]> {
    const rows = await this.db
      .select({ address: leaders.address })
      .from(leaders)
      .where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.active, true)));
    return rows.map((r) => r.address);
  }

  /** Eligible copy sources (as `FillSyncRepository.isCopied`), and the
   * actual copies whose mainnet fills trigger this deployment's engine. */
  async copiedAddresses(): Promise<{ copied: Set<string>; mainnet: Set<string> }> {
    const rows = await this.db
      .select({ address: copyStrategies.leaderAddress, mode: copyStrategies.mode })
      .from(copyStrategies)
      .where(and(eq(copyStrategies.chain, CHAIN_DEFAULT), inArray(copyStrategies.status, [...LIVE_STRATEGY_STATUSES]),
        copySourceEligibility(deploymentNetwork(this.config))));
    return {
      copied: new Set(rows.map((r) => r.address)),
      mainnet: new Set(rows.filter((r) => r.mode !== "paper").map((r) => r.address)),
    };
  }
}
