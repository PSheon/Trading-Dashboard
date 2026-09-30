import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, inArray } from "drizzle-orm";
import { equitySnapshots, fills, positionSnapshots } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";

/** Snapshot persistence only; cadence, aggregation and reconciliation policy stay in the service. */
@Injectable()
export class SchedulerRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Stored fills strictly after the previous snapshot, scoped to address, chain and changed coins. */
  async coinsWithFillsSince(address: string, changed: string[], since: Date): Promise<Set<string>> {
    const seen = await this.db
      .selectDistinct({ coin: fills.coin })
      .from(fills)
      .where(
        and(
          eq(fills.chain, CHAIN_DEFAULT),
          eq(fills.address, address),
          inArray(fills.coin, changed),
          gt(fills.ts, since),
        ),
      );
    return new Set(seen.map((row) => row.coin));
  }

  /** Write equity and all open positions in one caller-owned transaction; duplicates are ignored. */
  async save(tx: DbTransaction, equity: typeof equitySnapshots.$inferInsert,
    positions: (typeof positionSnapshots.$inferInsert)[]): Promise<void> {
    await tx.insert(equitySnapshots).values(equity).onConflictDoNothing();
    if (positions.length > 0) await tx.insert(positionSnapshots).values(positions).onConflictDoNothing();
  }
}
