import { Inject, Injectable } from "@nestjs/common";
import { and, eq, like, sql } from "drizzle-orm";
import { fills } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

/** Persisted dex discovery; the service owns remote refreshes and position caches. */
@Injectable()
export class AccountStateRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Distinct HIP-3 prefixes from fills on the configured chain for one address. */
  async knownDexes(address: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ dex: sql<string>`split_part(${fills.coin}, ':', 1)` })
      .from(fills)
      .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), like(fills.coin, "%:%")));
    return rows.map((row) => row.dex);
  }
}
