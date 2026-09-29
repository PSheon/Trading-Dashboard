import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, max } from "drizzle-orm";
import {
  actions,
  alerts as alertsTable,
  equitySnapshots,
  fills,
  leaderListItems,
  leaderLists,
  leaders,
  positionSnapshots,
} from "@trading-dashboard/shared/database";
import {
  CHAIN_DEFAULT,
  type AlertEntry,
  type Fill,
  type LeadersQuery,
  type PatchLeaderRequest,
  type PositionRow,
} from "@trading-dashboard/shared/contracts";

import type { AlertsScope } from "../../common/auth/alerts-scope.js";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

const FILLS_HISTORY_LIMIT = 200;
const ALERTS_HISTORY_LIMIT = 50;
@Injectable()
export class LeadersRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  findListed(query: LeadersQuery) {
    const conditions = [eq(leaders.chain, CHAIN_DEFAULT)];
    if (query.tier) conditions.push(eq(leaders.tier, query.tier));
    if (query.active !== undefined) conditions.push(eq(leaders.active, query.active));
    return this.db.select().from(leaders).where(and(...conditions));
  }
  async findOne(chain: string, address: string) {
    const [row] = await this.db.select().from(leaders).where(and(eq(leaders.chain, chain), eq(leaders.address, address))).limit(1);
    return row;
  }
  async update(chain: string, address: string, patch: PatchLeaderRequest) {
    const [row] = await this.db.update(leaders).set(patch).where(and(eq(leaders.chain, chain), eq(leaders.address, address))).returning();
    return row;
  }
  equityRows(chain: string, address: string, since: Date) {
    return this.db.select({ ts: equitySnapshots.ts, accountValue: equitySnapshots.accountValue }).from(equitySnapshots)
      .where(and(eq(equitySnapshots.chain, chain), eq(equitySnapshots.address, address), gte(equitySnapshots.ts, since)))
      .orderBy(equitySnapshots.ts);
  }
  async latestRank(address: string): Promise<number | null> {
    const [row] = await this.db
      .select({ rank: leaderListItems.rank })
      .from(leaderListItems)
      .innerJoin(leaderLists, eq(leaderLists.id, leaderListItems.listId))
      .where(eq(leaderListItems.address, address))
      .orderBy(desc(leaderLists.importedAt))
      .limit(1);
    return row?.rank ?? null;
  }
  async openPositionCount(chain: string, address: string): Promise<number> {
    const [latest] = await this.db
      .select({ ts: max(equitySnapshots.ts) })
      .from(equitySnapshots)
      .where(and(eq(equitySnapshots.chain, chain), eq(equitySnapshots.address, address)));
    if (!latest?.ts) return 0;

    const rows = await this.db
      .select({ coin: positionSnapshots.coin })
      .from(positionSnapshots)
      .where(
        and(
          eq(positionSnapshots.chain, chain),
          eq(positionSnapshots.address, address),
          eq(positionSnapshots.ts, latest.ts),
        ),
      );
    return rows.length;
  }
  async lastActionAt(chain: string, address: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ ts: actions.ts })
      .from(actions)
      .where(and(eq(actions.chain, chain), eq(actions.address, address)))
      .orderBy(desc(actions.ts))
      .limit(1);
    return row?.ts ?? null;
  }
  async currentPositions(chain: string, address: string): Promise<PositionRow[]> {
    const [latest] = await this.db
      .select({ ts: max(equitySnapshots.ts) })
      .from(equitySnapshots)
      .where(and(eq(equitySnapshots.chain, chain), eq(equitySnapshots.address, address)));
    if (!latest?.ts) return [];

    const rows = await this.db
      .select()
      .from(positionSnapshots)
      .where(
        and(
          eq(positionSnapshots.chain, chain),
          eq(positionSnapshots.address, address),
          eq(positionSnapshots.ts, latest.ts),
        ),
      );
    return rows as unknown as PositionRow[];
  }
  async fillsHistory(chain: string, address: string): Promise<Fill[]> {
    const rows = await this.db
      .select()
      .from(fills)
      .where(and(eq(fills.chain, chain), eq(fills.address, address)))
      .orderBy(desc(fills.ts))
      .limit(FILLS_HISTORY_LIMIT);
    return rows as unknown as Fill[];
  }
  async alertsHistory(address: string, scope: AlertsScope): Promise<AlertEntry[]> {
    if (scope === "none") return [];
    const rows = await this.db
      .select()
      .from(alertsTable)
      .where(
        scope === "all"
          ? eq(alertsTable.address, address)
          : and(eq(alertsTable.address, address), eq(alertsTable.userId, scope.userId)),
      )
      .orderBy(desc(alertsTable.sentAt))
      .limit(ALERTS_HISTORY_LIMIT);
    return rows as unknown as AlertEntry[];
  }
}
