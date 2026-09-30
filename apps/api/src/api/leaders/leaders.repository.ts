import type { DbTransaction } from "../../db/unit-of-work.js";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, max, sql } from "drizzle-orm";
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

/** The public projection of a leader (`publicLeaderSchema`). */
export const PUBLIC_LEADER_COLUMNS = {
  chain: leaders.chain,
  address: leaders.address,
  label: leaders.label,
  tier: leaders.tier,
  active: leaders.active,
  firstSeenAt: leaders.firstSeenAt,
};

const FILLS_HISTORY_LIMIT = 200;
const ALERTS_HISTORY_LIMIT = 50;
@Injectable()
export class LeadersRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  /** Full rows, favorite-only leaders and admin notes included: for
   * `leaders.manage` only. */
  findListed(query: LeadersQuery) {
    return this.db.select().from(leaders).where(and(...this.listConditions(query)));
  }
  /** What anyone may see: imported leaders only (a favorite-only leader
   * would reveal that users favorited it), without notes or source. */
  findListedPublic(query: LeadersQuery) {
    return this.db.select(PUBLIC_LEADER_COLUMNS).from(leaders)
      .where(and(...this.listConditions(query), eq(leaders.source, "import")));
  }
  private listConditions(query: LeadersQuery) {
    const conditions = [eq(leaders.chain, CHAIN_DEFAULT)];
    if (query.tier) conditions.push(eq(leaders.tier, query.tier));
    if (query.active !== undefined) conditions.push(eq(leaders.active, query.active));
    return conditions;
  }
  async summaryMetadata(addresses: string[]) {
    if (addresses.length === 0) return new Map<string, { rank: number | null; openPositionCount: number; lastActionAt: Date | null }>();
    // One round trip; correlated lookups use each table's address/time indexes.
    const result = await this.db.execute<{ address: string; rank: number | null; openPositionCount: number; lastActionAt: Date | null }>(sql`
      SELECT l.address,
        (SELECT i.rank FROM leader_list_items i JOIN leader_lists lists ON lists.id = i.list_id
          WHERE i.address = l.address ORDER BY lists.imported_at DESC, lists.id DESC LIMIT 1) AS rank,
        (SELECT count(*)::int FROM position_snapshots p WHERE p.chain = l.chain AND p.address = l.address
          AND p.ts = (SELECT max(e.ts) FROM equity_snapshots e WHERE e.chain = l.chain AND e.address = l.address)) AS "openPositionCount",
        (SELECT max(a.ts) FROM actions a WHERE a.chain = l.chain AND a.address = l.address) AS "lastActionAt"
      FROM leaders l WHERE l.chain = ${CHAIN_DEFAULT} AND l.address IN (${sql.join(addresses.map(address => sql`${address}`), sql`, `)})
    `);
    return new Map(result.rows.map(row => [row.address, row]));
  }
  async findOne(chain: string, address: string) {
    const [row] = await this.db.select().from(leaders).where(and(eq(leaders.chain, chain), eq(leaders.address, address))).limit(1);
    return row;
  }
  async lockOne(tx: DbTransaction, chain: string, address: string) {
    const [row] = await tx.select().from(leaders).where(and(eq(leaders.chain, chain), eq(leaders.address, address))).for("update");
    return row;
  }
  async update(tx: DbTransaction, chain: string, address: string, patch: PatchLeaderRequest) {
    const [row] = await tx.update(leaders).set(patch).where(and(eq(leaders.chain, chain), eq(leaders.address, address))).returning();
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
