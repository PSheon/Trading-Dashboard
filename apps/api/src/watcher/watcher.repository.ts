import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { leaders } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

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
}
