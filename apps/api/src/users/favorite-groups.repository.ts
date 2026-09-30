import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { userFavoriteGroupMembers, userFavoriteGroups, userFavorites, users } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbExecutor, DbTransaction } from "../db/unit-of-work.js";

export type FavoriteGroupRow = typeof userFavoriteGroups.$inferSelect;

/** `user_favorite_groups` and their members. Every read and write is
 * scoped to the owner; writes take the caller's transaction, which holds
 * the owner's user-row lock ({@link FavoriteGroupsRepository.lockUser}). */
@Injectable()
export class FavoriteGroupsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Serialises one user's group writes (count limit, sort order). */
  async lockUser(tx: DbTransaction, userId: number): Promise<void> {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
  }

  /** The user's groups in display order. */
  list(userId: number, executor: DbExecutor = this.db): Promise<FavoriteGroupRow[]> {
    return executor
      .select()
      .from(userFavoriteGroups)
      .where(eq(userFavoriteGroups.userId, userId))
      .orderBy(asc(userFavoriteGroups.sortOrder), asc(userFavoriteGroups.id));
  }

  /** Member addresses per group id, oldest first. */
  async members(groupIds: number[], executor: DbExecutor = this.db): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>(groupIds.map((id) => [id, []]));
    if (groupIds.length === 0) return out;
    const rows = await executor
      .select({ groupId: userFavoriteGroupMembers.groupId, address: userFavoriteGroupMembers.address })
      .from(userFavoriteGroupMembers)
      .where(inArray(userFavoriteGroupMembers.groupId, groupIds))
      .orderBy(asc(userFavoriteGroupMembers.createdAt), asc(userFavoriteGroupMembers.address));
    for (const row of rows) out.get(row.groupId)?.push(row.address);
    return out;
  }

  async findOwned(userId: number, id: number, executor: DbExecutor = this.db): Promise<FavoriteGroupRow | undefined> {
    const [row] = await executor
      .select()
      .from(userFavoriteGroups)
      .where(and(eq(userFavoriteGroups.userId, userId), eq(userFavoriteGroups.id, id)))
      .limit(1);
    return row;
  }

  async findByName(tx: DbTransaction, userId: number, name: string): Promise<FavoriteGroupRow | undefined> {
    const [row] = await tx
      .select()
      .from(userFavoriteGroups)
      .where(and(eq(userFavoriteGroups.userId, userId), eq(userFavoriteGroups.name, name)))
      .limit(1);
    return row;
  }

  async countOwned(tx: DbTransaction, userId: number): Promise<number> {
    const [{ n }] = await tx.select({ n: count() }).from(userFavoriteGroups).where(eq(userFavoriteGroups.userId, userId));
    return n;
  }

  async insert(tx: DbTransaction, values: { userId: number; name: string; color: string; sortOrder: number }): Promise<FavoriteGroupRow> {
    const [row] = await tx.insert(userFavoriteGroups).values(values).returning();
    return row;
  }

  async update(tx: DbTransaction, userId: number, id: number, set: Partial<Pick<FavoriteGroupRow, "name" | "color" | "sortOrder">>): Promise<void> {
    await tx.update(userFavoriteGroups).set(set).where(and(eq(userFavoriteGroups.userId, userId), eq(userFavoriteGroups.id, id)));
  }

  /** Deletes the group (its memberships cascade); true when it existed. */
  async remove(tx: DbTransaction, userId: number, id: number): Promise<boolean> {
    const rows = await tx
      .delete(userFavoriteGroups)
      .where(and(eq(userFavoriteGroups.userId, userId), eq(userFavoriteGroups.id, id)))
      .returning({ id: userFavoriteGroups.id });
    return rows.length > 0;
  }

  async isFavorite(tx: DbTransaction, userId: number, address: string): Promise<boolean> {
    const [row] = await tx
      .select({ address: userFavorites.address })
      .from(userFavorites)
      .where(and(eq(userFavorites.userId, userId), eq(userFavorites.chain, CHAIN_DEFAULT), eq(userFavorites.address, address)))
      .limit(1);
    return Boolean(row);
  }

  /** Idempotent. The caller has checked the group and the favorite. */
  async addMember(tx: DbTransaction, groupId: number, userId: number, address: string): Promise<void> {
    await tx.insert(userFavoriteGroupMembers).values({ groupId, userId, chain: CHAIN_DEFAULT, address }).onConflictDoNothing();
  }

  async removeMember(tx: DbTransaction, groupId: number, address: string): Promise<void> {
    await tx
      .delete(userFavoriteGroupMembers)
      .where(and(eq(userFavoriteGroupMembers.groupId, groupId), eq(userFavoriteGroupMembers.address, address)));
  }
}
