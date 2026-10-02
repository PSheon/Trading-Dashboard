import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray } from "drizzle-orm";
import { actions, fills } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

export type ActionRow = typeof actions.$inferSelect;

/** Ordered action history and address-scoped fill PnL; reconstruction remains a service policy. */
@Injectable()
export class RoundTripRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** `since`: only actions from then on (a list of many addresses must
   * bound what it loads); omitted, the whole history. */
  async history(addresses: string[], coin?: string, since?: Date): Promise<ActionRow[]> {
    const conditions = [eq(actions.chain, CHAIN_DEFAULT), inArray(actions.address, addresses)];
    if (coin) conditions.push(eq(actions.coin, coin));
    if (since) conditions.push(gte(actions.ts, since));

    const rows = await this.db
      .select()
      .from(actions)
      .where(and(...conditions))
      .orderBy(actions.ts, actions.id);

    return rows;
  }

  /** Chunk fill ids below the bind limit; address + tid prevents counterparty PnL leakage. */
  async pnlByTid(addresses: string[], allFillIds: bigint[]): Promise<Map<string, number>> {
    const pnlByTid = new Map<string, number>();
    // Chunk IN parameters below PostgreSQL's bind limit.
    for (let offset = 0; offset < allFillIds.length; offset += 20000) {
      const fillRows = await this.db
        .select({ address: fills.address, tid: fills.tid, closedPnl: fills.closedPnl })
        .from(fills)
        // tid is shared with the counterparty's fill: scope to this address.
        .where(
          and(eq(fills.chain, CHAIN_DEFAULT), inArray(fills.address, addresses), inArray(fills.tid, allFillIds.slice(offset, offset + 20000))),
        );
      for (const row of fillRows) {
        pnlByTid.set(`${row.address}\0${row.tid}`, row.closedPnl === null ? 0 : Number(row.closedPnl));
      }
    }

    return pnlByTid;
  }
}
