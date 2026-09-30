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
  FAVORITE_GROUP_COLORS,
  FAVORITE_GROUPS_MAX,
  favoriteGroupColor,
  favoriteGroupInputSchema,
  favoriteGroupPatchSchema,
  type FavoriteGroup,
} from '@trading-dashboard/shared/contracts';
import { parseOr400 } from '../common/http/validation.js';
import { DRIZZLE_CLIENT } from '../db/db.constants.js';
import type { DrizzleDb } from '../db/drizzle.provider.js';
import type { DbTransaction } from '../db/unit-of-work.js';
type GroupRow = typeof favoriteGroups.$inferSelect;
const toGroup = (row: GroupRow, addresses: string[]): FavoriteGroup => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  addresses,
  color: favoriteGroupColor(row),
  sortOrder: row.sortOrder,
});
/** A user's private favorite groups (the favorites page's group chips):
 * at most `FAVORITE_GROUPS_MAX`, names unique case-insensitively. Members
 * must be the user's favorites; unfavoriting drops the membership (FK
 * cascade) and deleting a group keeps the favorites. */
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
      .orderBy(
        asc(favoriteGroups.sortOrder),
        asc(favoriteGroups.id),
        asc(favoriteGroupMembers.address),
      );
    const groups = new Map<number, FavoriteGroup>();
    for (const { group, member } of rows) {
      if (!groups.has(group.id)) groups.set(group.id, toGroup(group, []));
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
    const input =
      id === undefined
        ? parseOr400(favoriteGroupInputSchema, body)
        : parseOr400(favoriteGroupPatchSchema, body);
    const { name } = input;
    return this.db.transaction(async (tx) => {
      await this.lock(tx, userId);
      if (id !== undefined) await this.owned(tx, userId, id);
      const existing = await tx
        .select()
        .from(favoriteGroups)
        .where(eq(favoriteGroups.userId, userId));
      if (id === undefined && existing.length >= FAVORITE_GROUPS_MAX)
        throw new ConflictException({
          code: 'group_limit',
          limit: FAVORITE_GROUPS_MAX,
          message: `Up to ${FAVORITE_GROUPS_MAX} groups per user`,
        });
      const duplicates =
        name === undefined
          ? []
          : await tx
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
          ? await tx
              .insert(favoriteGroups)
              .values({
                userId,
                name: name!,
                color:
                  input.color ??
                  FAVORITE_GROUP_COLORS[
                    existing.length % FAVORITE_GROUP_COLORS.length
                  ],
                sortOrder: existing.reduce(
                  (max, g) => Math.max(max, g.sortOrder + 1),
                  0,
                ),
              })
              .returning()
          : await tx
              .update(favoriteGroups)
              .set({
                ...(name === undefined ? {} : { name }),
                ...(input.color === undefined ? {} : { color: input.color }),
                ...('sortOrder' in input && input.sortOrder !== undefined
                  ? { sortOrder: input.sortOrder }
                  : {}),
              })
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
      return toGroup(
        row!,
        members.map((m) => m.address),
      );
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
