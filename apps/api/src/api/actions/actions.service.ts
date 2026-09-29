import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  CHAIN_DEFAULT,
  actions,
  fills,
  leaders,
  userFavorites,
  type ActionFeedItem,
  type ActionsFeedQuery,
  type Fill,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

/** D1 Live Feed — reads the aggregated `actions` table only (§3 principle 3),
 * left-joined to `leaders` for the label/tier shown in each row and for the
 * tier filter. */
@Injectable()
export class ActionsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** `favoritesOf`: only addresses this user favorited. */
  async findFeed(query: ActionsFeedQuery, favoritesOf?: number): Promise<ActionFeedItem[]> {
    const conditions = [eq(actions.chain, CHAIN_DEFAULT)];
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
    if (query.coin) conditions.push(eq(actions.coin, query.coin));
    if (query.kind) conditions.push(eq(actions.kind, query.kind));
    if (query.tier) conditions.push(eq(leaders.tier, query.tier));
    if (query.before) conditions.push(lt(actions.ts, new Date(query.before)));

    const limit = query.limit ? Number(query.limit) : 100;

    const rows = await this.db
      .select({
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
      })
      .from(actions)
      .leftJoin(leaders, and(eq(leaders.chain, actions.chain), eq(leaders.address, actions.address)))
      .where(and(...conditions))
      .orderBy(desc(actions.ts))
      .limit(limit);

    return rows as unknown as ActionFeedItem[];
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
