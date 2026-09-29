import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { CHAIN_DEFAULT, leaders, traderStats, userFavorites, type Favorite } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { BackfillService } from "../watcher/backfill.service.js";
import { toTraderStats } from "./trader-stats.mapper.js";

/**
 * A user's favorites. A favorited address joins the watch list (`leaders`):
 * - not there yet → created with `source='favorite'` and backfilled;
 * - there, favorite-sourced but inactive → reactivated;
 * - imported by an admin → left exactly as it is.
 * Removing the last favorite of a favorite-sourced leader deactivates it;
 * imported leaders are never touched.
 */
@Injectable()
export class FavoritesService {
  private readonly logger = new Logger(FavoritesService.name);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly backfill: BackfillService,
  ) {}

  async list(userId: number): Promise<Favorite[]> {
    const rows = await this.db
      .select({ favorite: userFavorites, stats: traderStats })
      .from(userFavorites)
      .leftJoin(
        traderStats,
        and(eq(traderStats.chain, userFavorites.chain), eq(traderStats.address, userFavorites.address)),
      )
      .where(eq(userFavorites.userId, userId))
      .orderBy(desc(userFavorites.createdAt));
    return rows.map((r) => ({
      address: r.favorite.address,
      createdAt: r.favorite.createdAt,
      stats: r.stats ? toTraderStats(r.stats) : null,
    }));
  }

  /** Idempotent. `address` must already be validated and lowercased. */
  async add(userId: number, address: string): Promise<Favorite> {
    const chain = CHAIN_DEFAULT;
    const createdLeader = await this.db.transaction(async (tx) => {
      await tx.insert(userFavorites).values({ userId, chain, address }).onConflictDoNothing();

      const inserted = await tx
        .insert(leaders)
        .values({ chain, address, active: true, source: "favorite" })
        .onConflictDoNothing({ target: [leaders.chain, leaders.address] })
        .returning({ address: leaders.address });
      if (inserted.length > 0) return true;

      await tx
        .update(leaders)
        .set({ active: true })
        .where(
          and(
            eq(leaders.chain, chain),
            eq(leaders.address, address),
            eq(leaders.source, "favorite"),
            eq(leaders.active, false),
          ),
        );
      return false;
    });

    if (createdLeader) {
      this.logger.log(`New favorite-sourced leader ${address} — starting backfill`);
      this.backfill.trigger(address);
    }

    const favorite = (await this.list(userId)).find((f) => f.address === address);
    // Just written in this request; only a concurrent DELETE could remove it.
    return favorite ?? { address, createdAt: new Date(), stats: null };
  }

  /** Idempotent; returns whether a favorite was removed. */
  async remove(userId: number, address: string): Promise<boolean> {
    const chain = CHAIN_DEFAULT;
    return this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(userFavorites)
        .where(
          and(eq(userFavorites.userId, userId), eq(userFavorites.chain, chain), eq(userFavorites.address, address)),
        )
        .returning({ address: userFavorites.address });

      // Lock the leader first so the check below runs on a fresh snapshot
      // and can't miss a favorite another user is adding right now.
      await tx
        .select({ address: leaders.address })
        .from(leaders)
        .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
        .for("update");

      await tx
        .update(leaders)
        .set({ active: false })
        .where(
          and(
            eq(leaders.chain, chain),
            eq(leaders.address, address),
            eq(leaders.source, "favorite"),
            sql`not exists (
              select 1 from ${userFavorites}
              where ${userFavorites.chain} = ${chain} and ${userFavorites.address} = ${address}
            )`,
          ),
        );
      return removed.length > 0;
    });
  }
}
