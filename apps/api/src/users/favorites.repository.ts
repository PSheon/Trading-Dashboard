import { enqueueBackfills } from "../jobs/backfill-jobs.repository.js";
import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { leaders, notificationChannels, traderStats, userFavorites, users } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
export type FavoriteUpdate = Partial<typeof userFavorites.$inferInsert>;

/** Owned favorites and transactional alert/watch-state persistence. */
@Injectable()
export class FavoritesRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  listOwned(userId: number, address?: string) {
    return this.db.select({ favorite: userFavorites, stats: traderStats }).from(userFavorites)
      .leftJoin(traderStats, and(eq(traderStats.chain, userFavorites.chain), eq(traderStats.address, userFavorites.address)))
      .where(and(eq(userFavorites.userId, userId), eq(userFavorites.chain, CHAIN_DEFAULT), address === undefined ? undefined : eq(userFavorites.address, address)))
      .orderBy(desc(userFavorites.createdAt));
  }
  async lockUser(tx: DbTransaction, userId: number) { await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update"); }
  private owned(userId: number, address: string) { return and(eq(userFavorites.userId, userId), eq(userFavorites.chain, CHAIN_DEFAULT), eq(userFavorites.address, address)); }
  async findOwned(tx: DbTransaction, userId: number, address: string) {
    const [row] = await tx.select().from(userFavorites).where(this.owned(userId, address)); return row;
  }
  async hasTelegram(tx: DbTransaction, userId: number) {
    const [row] = await tx.select({ id: notificationChannels.id }).from(notificationChannels).where(and(
      eq(notificationChannels.userId, userId), eq(notificationChannels.kind, "telegram"), eq(notificationChannels.enabled, true)));
    return Boolean(row);
  }
  async countOwned(tx: DbTransaction, userId: number) {
    const [{ n }] = await tx.select({ n: count() }).from(userFavorites).where(eq(userFavorites.userId, userId));
    return n;
  }
  async countAlerts(tx: DbTransaction, userId: number) {
    const [{ n }] = await tx.select({ n: count() }).from(userFavorites).where(and(eq(userFavorites.userId, userId), eq(userFavorites.alertEnabled, true)));
    return n;
  }
  async updateAlert(tx: DbTransaction, userId: number, address: string, patch: Partial<typeof userFavorites.$inferInsert>) {
    await tx.update(userFavorites).set(patch).where(this.owned(userId, address));
  }
  async addAndWatch(tx: DbTransaction, userId: number, address: string) {
    const chain = CHAIN_DEFAULT;
    await tx.insert(userFavorites).values({ userId, chain, address }).onConflictDoNothing();
    const inserted = await tx.insert(leaders).values({ chain, address, active: true, source: "favorite" })
      .onConflictDoNothing({ target: [leaders.chain, leaders.address] }).returning({ address: leaders.address });
    if (inserted.length) { await enqueueBackfills(tx, [address], "favorite"); return true; }
    await tx.update(leaders).set({ active: true }).where(and(eq(leaders.chain, chain), eq(leaders.address, address), eq(leaders.source, "favorite"), eq(leaders.active, false)));
    return false;
  }
  async removeAndUnwatch(tx: DbTransaction, userId: number, address: string) {
    const chain = CHAIN_DEFAULT;
    const removed = await tx.delete(userFavorites).where(this.owned(userId, address)).returning({ address: userFavorites.address });
    await tx.select({ address: leaders.address }).from(leaders).where(and(eq(leaders.chain, chain), eq(leaders.address, address))).for("update");
    await tx.update(leaders).set({ active: false }).where(and(eq(leaders.chain, chain), eq(leaders.address, address), eq(leaders.source, "favorite"),
      sql`not exists (select 1 from ${userFavorites} where ${userFavorites.chain} = ${chain} and ${userFavorites.address} = ${address})`));
    return removed.length > 0;
  }
}
