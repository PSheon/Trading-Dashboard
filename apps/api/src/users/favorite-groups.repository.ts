import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  favoriteGroups,
  favoriteGroupMembers,
  userFavorites,
  users,
} from '@trading-dashboard/shared/database';
import {
  favoriteGroupInputSchema,
  type FavoriteGroup,
} from '@trading-dashboard/shared/contracts';
import { parseOr400 } from '../common/http/validation.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
@Injectable()
export class FavoriteGroupsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async list(userId: number): Promise<FavoriteGroup[]> {
    const rows = await this.db
      .select({ group: favoriteGroups, member: favoriteGroupMembers.address })
      .from(favoriteGroups)
      .leftJoin(
        favoriteGroupMembers,
        and(
          eq(favoriteGroups.id, favoriteGroupMembers.groupId),
          eq(favoriteGroupMembers.userId, userId),
        ),
      )
      .where(eq(favoriteGroups.userId, userId))
      .orderBy(asc(favoriteGroups.id), asc(favoriteGroupMembers.address));
    const groups = new Map<number, FavoriteGroup>();
    for (const { group, member } of rows) {
      if (!groups.has(group.id))
        groups.set(group.id, {
          id: group.id,
          name: group.name,
          createdAt: group.createdAt.toISOString(),
          addresses: [],
        });
      if (member) groups.get(group.id)!.addresses.push(member);
    }
    return [...groups.values()];
  }
  private async lock(tx: DbTransaction, userId: number) {
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!row) throw new NotFoundException('User not found');
  }
  private async owned(tx: DbTransaction, userId: number, id: number) {
    const [row] = await tx
      .select()
      .from(favoriteGroups)
      .where(and(eq(favoriteGroups.id, id), eq(favoriteGroups.userId, userId)))
      .for('update');
    if (!row) throw new NotFoundException('Group not found');
    return row;
  }
  async save(
    userId: number,
    body: unknown,
    id?: number,
  ): Promise<FavoriteGroup> {
    const { name } = parseOr400(favoriteGroupInputSchema, body);
    return this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      if (id !== undefined) await this.owned(tx, userId, id);
      const existing = await tx
        .select()
        .from(favoriteGroups)
        .where(eq(favoriteGroups.userId, userId));
      if (id === undefined && existing.length >= 20)
        throw new ConflictException({
          code: 'group_limit',
          message: 'Up to 20 groups per user',
        });
      const duplicates = await tx
        .select({ id: favoriteGroups.id })
        .from(favoriteGroups)
        .where(
          and(
            eq(favoriteGroups.userId, userId),
            sql`lower(${favoriteGroups.name}) = lower(${name})`,
          ),
        );
      if (duplicates.some((row) => row.id !== id))
        throw new ConflictException({
          code: 'group_name_exists',
          message: 'Group name already exists',
        });
      const [row] =
        id === undefined
          ? await tx.insert(favoriteGroups).values({ userId, name }).returning()
          : await tx
              .update(favoriteGroups)
              .set({ name })
              .where(
                and(
                  eq(favoriteGroups.id, id),
                  eq(favoriteGroups.userId, userId),
                ),
              )
              .returning();
      const members = await tx
        .select({ address: favoriteGroupMembers.address })
        .from(favoriteGroupMembers)
        .where(
          and(
            eq(favoriteGroupMembers.userId, userId),
            eq(favoriteGroupMembers.groupId, row.id),
          ),
        )
        .orderBy(asc(favoriteGroupMembers.address));
      return {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
        addresses: members.map((m) => m.address),
      };
    });
  }
  async remove(userId: number, id: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      await this.owned(tx, userId, id);
      await tx
        .delete(favoriteGroups)
        .where(
          and(eq(favoriteGroups.id, id), eq(favoriteGroups.userId, userId)),
        );
    });
  }
  async member(
    userId: number,
    id: number,
    address: string,
    add: boolean,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      await this.owned(tx, userId, id);
      const owned = and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.chain, 'hyperliquid'),
        eq(userFavorites.address, address),
      );
      // Locks the favorite against concurrent removal before establishing its FK.
      const [favorite] = await tx
        .select({ address: userFavorites.address })
        .from(userFavorites)
        .where(owned)
        .for('update');
      if (!favorite) throw new NotFoundException('Favorite not found');
      if (add)
        await tx
          .insert(favoriteGroupMembers)
          .values({ userId, groupId: id, chain: 'hyperliquid', address })
          .onConflictDoNothing();
      else
        await tx
          .delete(favoriteGroupMembers)
          .where(
            and(
              eq(favoriteGroupMembers.userId, userId),
              eq(favoriteGroupMembers.groupId, id),
              eq(favoriteGroupMembers.chain, 'hyperliquid'),
              eq(favoriteGroupMembers.address, address),
            ),
          );
    });
  }
}
