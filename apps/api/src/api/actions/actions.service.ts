import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, inArray, lt, or, type SQL } from "drizzle-orm";
import { actions, fills, leaders, userFavorites } from "@trading-dashboard/shared/database";
import {
  CHAIN_DEFAULT,
  type ActionFeedItem,
  type ActionsFeedQuery,
  type ActionsStreamQuery,
  type Fill,
} from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

/** The feed's filters (GET /actions and GET /actions/stream). */
export type ActionsFeedFilter = Pick<ActionsStreamQuery, "address" | "coin" | "kind" | "tier">;

/** One feed row: the action plus its leader's label/tier. */
const feedColumns = {
  id: actions.id,
  chain: actions.chain,
  address: actions.address,
  coin: actions.coin,
  kind: actions.kind,
  side: actions.side,
  notionalUsd: actions.notionalUsd,
  avgPx: actions.avgPx,
  leverage: actions.leverage,
  fillIds: actions.fillIds,
  ts: actions.ts,
  leaderLabel: leaders.label,
  leaderTier: leaders.tier,
};

/** D1 Live Feed — reads the aggregated `actions` table only (§3 principle 3),
 * left-joined to `leaders` for the label/tier shown in each row and for the
 * tier filter. */
@Injectable()
export class ActionsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** `favoritesOf`: only addresses this user favorited. */
  async findFeed(query: ActionsFeedQuery, favoritesOf?: number): Promise<ActionFeedItem[]> {
    const conditions = this.filterConditions(query, favoritesOf);
    if (query.before) {
      const before = new Date(query.before);
      conditions.push(query.beforeId
        ? or(lt(actions.ts, before), and(eq(actions.ts, before), lt(actions.id, BigInt(query.beforeId))))!
        : lt(actions.ts, before));
    }

    const limit = query.limit ? Number(query.limit) : 100;
    return this.select(and(...conditions)).orderBy(desc(actions.ts), desc(actions.id)).limit(limit) as unknown as Promise<ActionFeedItem[]>;
  }

  /** Feed rows by id (the live stream's lookup for new/corrected actions),
   * in ascending id order. */
  async findByIds(ids: readonly bigint[]): Promise<ActionFeedItem[]> {
    if (ids.length === 0) return [];
    return this.select(inArray(actions.id, [...ids])).orderBy(asc(actions.id)) as unknown as Promise<ActionFeedItem[]>;
  }

  /**
   * The stream's resume replay: matching rows with an id above `afterId` and
   * a timestamp from `since` on, newest `limit` of them, in ascending id order.
   * `truncated`: more rows matched than `limit`.
   */
  async findAfter(
    filter: ActionsFeedFilter,
    afterId: bigint,
    since: Date,
    limit: number,
    favoritesOf?: number,
  ): Promise<{ rows: ActionFeedItem[]; truncated: boolean }> {
    const conditions = this.filterConditions(filter, favoritesOf);
    conditions.push(gt(actions.id, afterId), gte(actions.ts, since));
    const rows = (await this.select(and(...conditions)).orderBy(desc(actions.id)).limit(limit + 1)) as unknown as ActionFeedItem[];
    const truncated = rows.length > limit;
    return { rows: rows.slice(0, limit).reverse(), truncated };
  }

  /** Addresses this user favorited (lowercase). */
  async favoriteAddresses(userId: number): Promise<Set<string>> {
    const rows = await this.db
      .select({ address: userFavorites.address })
      .from(userFavorites)
      .where(and(eq(userFavorites.userId, userId), eq(userFavorites.chain, CHAIN_DEFAULT)));
    return new Set(rows.map((r) => r.address.toLowerCase()));
  }

  private filterConditions(filter: ActionsFeedFilter, favoritesOf?: number): SQL[] {
    const conditions: SQL[] = [eq(actions.chain, CHAIN_DEFAULT)];
    if (favoritesOf !== undefined) {
      conditions.push(
        inArray(
          actions.address,
          this.db
            .select({ address: userFavorites.address })
            .from(userFavorites)
            .where(and(eq(userFavorites.userId, favoritesOf), eq(userFavorites.chain, CHAIN_DEFAULT))),
        ),
      );
    }
    if (filter.address) conditions.push(eq(actions.address, filter.address.toLowerCase()));
    if (filter.coin) conditions.push(eq(actions.coin, filter.coin));
    if (filter.kind) conditions.push(eq(actions.kind, filter.kind));
    if (filter.tier) conditions.push(eq(leaders.tier, filter.tier));
    return conditions;
  }

  private select(where: SQL | undefined) {
    return this.db
      .select(feedColumns)
      .from(actions)
      .leftJoin(leaders, and(eq(leaders.chain, actions.chain), eq(leaders.address, actions.address)))
      .where(where);
  }

  /** Backs the D1 "expand a row to see its constituent fills" interaction. */
  async getFillsForAction(actionId: bigint): Promise<Fill[]> {
    const [action] = await this.db.select().from(actions).where(eq(actions.id, actionId)).limit(1);
    if (!action) {
      throw new NotFoundException(`No action ${actionId}`);
    }
    if (action.fillIds.length === 0) return [];

    const rows = await this.db
      .select()
      .from(fills)
      // tid is shared with the counterparty's fill: scope to this address.
      .where(
        and(
          eq(fills.chain, action.chain),
          eq(fills.address, action.address),
          inArray(fills.tid, action.fillIds),
        ),
      )
      .orderBy(fills.ts);

    return rows as unknown as Fill[];
  }
}
