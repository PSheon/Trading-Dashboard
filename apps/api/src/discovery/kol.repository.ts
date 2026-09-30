import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { kolTraders } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbExecutor, DbTransaction } from "../db/unit-of-work.js";

export type KolRow = typeof kolTraders.$inferSelect;
export type KolValues = Pick<KolRow, "address" | "displayName" | "avatarUrl" | "xHandle" | "verified" | "sortOrder">;

const mine = eq(kolTraders.chain, CHAIN_DEFAULT);

/** `kol_traders`: the KOL registry. Writes take the caller's transaction. */
@Injectable()
export class KolRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async previewSnapshot():Promise<KolValues[]>{
    return this.db.transaction(async tx=>{
      await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
      return tx.select({address:kolTraders.address,displayName:kolTraders.displayName,avatarUrl:kolTraders.avatarUrl,xHandle:kolTraders.xHandle,verified:kolTraders.verified,sortOrder:kolTraders.sortOrder}).from(kolTraders).where(mine).orderBy(asc(kolTraders.address)).limit(5001);
    },{accessMode:'read only'});
  }

  /** Registry order: sort order, then address. */
  list(executor: DbExecutor = this.db): Promise<KolRow[]> {
    return executor.select().from(kolTraders).where(mine).orderBy(asc(kolTraders.sortOrder), asc(kolTraders.address));
  }

  async find(address: string, executor: DbExecutor = this.db): Promise<KolRow | undefined> {
    const [row] = await executor.select().from(kolTraders).where(and(mine, eq(kolTraders.address, address))).limit(1);
    return row;
  }

  /** Locks the listed rows (or none) for the rest of the transaction. */
  async lockExisting(tx: DbTransaction, addresses: string[]): Promise<KolRow[]> {
    if (addresses.length === 0) return [];
    return tx.select().from(kolTraders).where(and(mine, inArray(kolTraders.address, addresses))).for("update");
  }

  async upsert(tx: DbTransaction, values: KolValues): Promise<KolRow> {
    const [row] = await tx
      .insert(kolTraders)
      .values({ chain: CHAIN_DEFAULT, ...values })
      .onConflictDoUpdate({
        target: [kolTraders.chain, kolTraders.address],
        set: {
          displayName: values.displayName,
          avatarUrl: values.avatarUrl,
          xHandle: values.xHandle,
          verified: values.verified,
          sortOrder: values.sortOrder,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row;
  }

  async remove(tx: DbTransaction, address: string): Promise<KolRow | undefined> {
    const [row] = await tx.delete(kolTraders).where(and(mine, eq(kolTraders.address, address))).returning();
    return row;
  }

  /** Deletes every KOL not in `keep`; returns how many. */
  async removeOthers(tx: DbTransaction, keep: string[]): Promise<number> {
    const rows = await tx
      .delete(kolTraders)
      .where(keep.length > 0 ? and(mine, notInArray(kolTraders.address, keep)) : mine)
      .returning({ address: kolTraders.address });
    return rows.length;
  }
}
