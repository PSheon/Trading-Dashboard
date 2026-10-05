import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNotNull, like, max, notLike, or, sql, type SQL } from "drizzle-orm";
import { discoveryTraders, fillCoverage, fills, leaders, traderStats, userFavorites } from "@trading-dashboard/shared/database";
import {
  CHAIN_DEFAULT,
  type ActiveWithin,
  type DiscoverySettings,
  type TradersQuery,
} from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
const SORT_COLUMNS = {
  accountPnl: { day: traderStats.pnlDay, week: traderStats.pnlWeek, month: traderStats.pnlMonth, allTime: traderStats.pnlAllTime },
  accountRoi: { day: traderStats.roiDay, week: traderStats.roiWeek, month: traderStats.roiMonth, allTime: traderStats.roiAllTime },
  volume: {
    day: traderStats.volumeDay,
    week: traderStats.volumeWeek,
    month: traderStats.volumeMonth,
    allTime: traderStats.volumeAllTime,
  },
} as const;

/** Volume column per activity filter: "traded within the window" means that
 * window's leaderboard volume is above zero (Stage 2 §12). */
const ACTIVE_VOLUME_COLUMNS = {
  day: traderStats.volumeDay,
  week: traderStats.volumeWeek,
  month: traderStats.volumeMonth,
} as const;

/** The WHERE condition for an activity filter; none for "any". */
export function activeCondition(active: ActiveWithin): SQL | undefined {
  return active === "any" ? undefined : gt(ACTIVE_VOLUME_COLUMNS[active], "0");
}

/** Escapes LIKE/ILIKE wildcards in user input. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Perp coins only: spot is "@107" or "PURR/USDC". */
const perpFillsOnly = [notLike(fills.coin, "@%"), notLike(fills.coin, "%/%")];

@Injectable()
export class TradersRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  async findPage(query: TradersQuery, discovery: DiscoverySettings) {
    const conditions: SQL[] = [eq(traderStats.chain, CHAIN_DEFAULT)];
    const q = query.q?.trim();
    if (q) {
      conditions.push(
        or(
          like(traderStats.address, `${likeEscape(q.toLowerCase())}%`),
          ilike(traderStats.displayName, `%${likeEscape(q)}%`),
        )!,
      );
    }
    if (query.minAccountValue !== undefined) {
      conditions.push(gte(traderStats.accountValue, String(query.minAccountValue)));
    }
    const hideVaults = query.hideVaults ?? discovery.hideVaults;
    if (hideVaults) conditions.push(eq(traderStats.isVault, false));
    const active = activeCondition(query.active ?? discovery.defaultActiveWithin);
    if (active) conditions.push(active);
    const where = and(...conditions);
    const column = query.sort === "accountValue" ? traderStats.accountValue : SORT_COLUMNS[query.sort][query.window];
    const direction = query.order === "asc" ? asc : desc;

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(traderStats)
        .where(where)
        .orderBy(direction(column), asc(traderStats.address))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(traderStats).where(where),
    ]);

    return { rows, total };
  }
  async favoritesAmong(userId: number | null, addresses: string[]): Promise<Set<string>> {
    if (userId === null || addresses.length === 0) return new Set();
    const rows = await this.db
      .select({ address: userFavorites.address })
      .from(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, userId),
          eq(userFavorites.chain, CHAIN_DEFAULT),
          inArray(userFavorites.address, addresses),
        ),
      );
    return new Set(rows.map((r) => r.address));
  }
  async isTracked(address: string): Promise<boolean> {
    const rows = await this.db
      .select({ address: leaders.address })
      .from(leaders)
      .where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.address, address), eq(leaders.active, true)))
      .limit(1);
    return rows.length > 0;
  }
  /** The discovery pool's stored sparklines (refreshed by its own job) for
   * those of `addresses` it holds. */
  poolSparklines(addresses: string[]) {
    if (addresses.length === 0) return Promise.resolve([]);
    return this.db
      .select({
        address: discoveryTraders.address,
        sparkline: discoveryTraders.sparkline,
        sparkline30d: discoveryTraders.sparkline30d,
        spanDays: discoveryTraders.spanDays,
        portfolioAt: discoveryTraders.portfolioAt,
      })
      .from(discoveryTraders)
      .where(and(eq(discoveryTraders.chain, CHAIN_DEFAULT), inArray(discoveryTraders.address, addresses), isNotNull(discoveryTraders.portfolioAt)));
  }
  /** Those of `addresses` the site lists anywhere: the imported leaderboard
   * or the discovery pool. */
  async knownAddresses(addresses: string[]): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const [stats, pool] = await Promise.all([
      this.db.select({ address: traderStats.address }).from(traderStats)
        .where(and(eq(traderStats.chain, CHAIN_DEFAULT), inArray(traderStats.address, addresses))),
      this.db.select({ address: discoveryTraders.address }).from(discoveryTraders)
        .where(and(eq(discoveryTraders.chain, CHAIN_DEFAULT), inArray(discoveryTraders.address, addresses))),
    ]);
    return new Set([...stats, ...pool].map((r) => r.address));
  }
  findStats(address: string) {
    return this.db.select().from(traderStats).where(and(eq(traderStats.chain, CHAIN_DEFAULT), eq(traderStats.address, address))).limit(1);
  }
  /** Where our stored fills of a watched address are verified complete
   * (`fill_coverage`), if anywhere. */
  async verifiedFrom(address: string): Promise<Date | null> {
    const [row] = await this.db.select({ verifiedFrom: fillCoverage.verifiedFrom }).from(fillCoverage)
      .where(and(eq(fillCoverage.chain, CHAIN_DEFAULT), eq(fillCoverage.address, address))).limit(1);
    return row?.verifiedFrom ?? null;
  }
  async fillSample(address: string, since: Date) {
    const mine = and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), ...perpFillsOnly);
    const [[{ n }], [{ last }]] = await Promise.all([
      this.db.select({ n: count() }).from(fills).where(and(mine, gte(fills.ts, since))),
      this.db.select({ last: max(fills.ts) }).from(fills).where(mine),
    ]);
    return { n, last };
  }

  recentFills(address: string, limit: number) {
    return this.db
        .select({
          tid: fills.tid,
          coin: fills.coin,
          side: fills.side,
          dir: fills.dir,
          px: fills.px,
          sz: fills.sz,
          fee: fills.fee,
          closedPnl: fills.closedPnl,
          ts: fills.ts,
          twapId: sql<string | null>`${fills.raw}->>'twapId'`,
          startPosition: sql<string | null>`${fills.raw}->>'startPosition'`,
          liquidation: sql<boolean>`coalesce(jsonb_typeof(${fills.raw}->'liquidation') not in ('null'), false)`,
        })
        .from(fills)
        // Perp and spot, as CopyDog's 成交 tab lists them.
        .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address)))
        .orderBy(desc(fills.ts), desc(fills.tid))
        .limit(limit);
  }
}
