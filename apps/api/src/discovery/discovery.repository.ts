import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, like, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { archiveCoverage, copyStrategies, discoveryTraders, fills, kolAvatars, kolTraders, traderAnalytics, traderStats, traderTrades, userFavorites } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HistoryFillStore } from "../traders/history-fill.store.js";
import type { DbTransaction } from "../db/unit-of-work.js";

export type DiscoveryRow = typeof discoveryTraders.$inferSelect;
export type DiscoveryFigures = Partial<Omit<typeof discoveryTraders.$inferInsert, "chain" | "address" | "poolRank" | "inPool">>;

/** What the pool loops order their work by. */
export type PoolQueueRow = Pick<DiscoveryRow, "address" | "poolRank" | "portfolioAt" | "tradesAt" | "attemptedAt" | "performanceAttemptedAt" | "lastError">;

/** A pool row with the KOL entry and leaderboard name it is shown with. */
export interface BoardSourceRow extends DiscoveryRow {
  kolName: string | null;
  /** ETag of the KOL's cached avatar; null when none is cached. */
  kolAvatarEtag: string | null;
  kolXHandle: string | null;
  kolVerified: boolean | null;
  kolSortOrder: number | null;
  leaderboardName: string | null;
  /** Leaderboard account value (free, refreshed with every import). */
  leaderboardAccountValue: string | null;
  leaderboardVolumeMonth?: string | null;
  leaderboardUpdatedAt?: Date | null;
  /** Local archive high-fill-rate exclusion; only a market-maker proxy. */
  archiveExcluded?: boolean;
}

/** A card's identity and leaderboard figures, for a trader the pool has
 * no figures for. */
export interface CardIdentityRow {
  address: string;
  displayName: string | null;
  accountValue: string | null;
  pnlAllTime: string | null;
  roiAllTime: string | null;
  pnlMonth: string | null;
  /** When the leaderboard row was imported: the time behind its figures. */
  statsUpdatedAt: Date | null;
  kolName: string | null;
  kolXHandle: string | null;
  kolVerified: boolean | null;
  kolAvatarEtag: string | null;
}

export interface CoinAggregate {
  coin: string;
  pnl: number;
  volume: number;
  trades: number;
  wins: number;
}

const mine = eq(discoveryTraders.chain, CHAIN_DEFAULT);
/** Escapes LIKE wildcards so a query is matched literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * `discovery_traders` (the pool's cached figures) plus the reads the pool
 * job needs from `trader_stats`, `kol_traders` and the trade ledger.
 */
@Injectable()
export class DiscoveryRepository {
  private readonly history: HistoryFillStore;
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {
    this.history = new HistoryFillStore(db);
  }

  transaction<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * The leaderboard's top `limit` by all-time PnL among non-vault accounts
   * with volume in the last 30 days and a positive account value.
   */
  async candidates(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ address: traderStats.address })
      .from(traderStats)
      .where(and(eq(traderStats.chain, CHAIN_DEFAULT), eq(traderStats.isVault, false), gt(traderStats.volumeMonth, "0"), gt(traderStats.accountValue, "0")))
      .orderBy(desc(traderStats.pnlAllTime), asc(traderStats.address))
      .limit(limit);
    return rows.map((r) => r.address);
  }

  async kolAddresses(): Promise<string[]> {
    const rows = await this.db.select({ address: kolTraders.address }).from(kolTraders).where(eq(kolTraders.chain, CHAIN_DEFAULT));
    return rows.map((r) => r.address);
  }

  /**
   * Makes the pool exactly `entries`: new addresses are added (never
   * attempted, so they go first), ranks are updated, and rows no longer
   * selected are deleted. One transaction.
   */
  async syncPool(tx: DbTransaction, entries: Array<{ address: string; poolRank: number | null }>): Promise<{ added: number; removed: number }> {
    let added = 0;
    for (let i = 0; i < entries.length; i += 1000) {
      const chunk = entries.slice(i, i + 1000);
      const rows = await tx
        .insert(discoveryTraders)
        .values(chunk.map((e) => ({ chain: CHAIN_DEFAULT, address: e.address, poolRank: e.poolRank, inPool: true })))
        .onConflictDoUpdate({
          target: [discoveryTraders.chain, discoveryTraders.address],
          set: { poolRank: sql`excluded.pool_rank`, inPool: true },
        })
        .returning({ inserted: sql<boolean>`xmax = 0` });
      added += rows.filter((r) => r.inserted).length;
    }
    const keep = entries.map((e) => e.address);
    const removed = await tx
      .delete(discoveryTraders)
      .where(keep.length > 0 ? and(mine, notInArray(discoveryTraders.address, keep)) : mine)
      .returning({ address: discoveryTraders.address });
    return { added, removed: removed.length };
  }

  /** Every pool row's timestamps: the loops order their queues in memory
   * (≈ 1,200 rows, once a tick). */
  queueRows(): Promise<PoolQueueRow[]> {
    return this.db
      .select({
        address: discoveryTraders.address,
        poolRank: discoveryTraders.poolRank,
        portfolioAt: discoveryTraders.portfolioAt,
        tradesAt: discoveryTraders.tradesAt,
        attemptedAt: discoveryTraders.attemptedAt,
        performanceAttemptedAt: discoveryTraders.performanceAttemptedAt,
        lastError: discoveryTraders.lastError,
      })
      .from(discoveryTraders)
      .where(and(mine, eq(discoveryTraders.inPool, true)));
  }

  /** Addresses someone favorited or copies (a live copy strategy). */
  async followedAddresses(): Promise<Set<string>> {
    const [favorites, copied] = await Promise.all([
      this.db.selectDistinct({ address: userFavorites.address }).from(userFavorites).where(eq(userFavorites.chain, CHAIN_DEFAULT)),
      this.db.selectDistinct({ address: copyStrategies.leaderAddress }).from(copyStrategies)
        .where(and(eq(copyStrategies.chain, CHAIN_DEFAULT), sql`${copyStrategies.status} <> 'stopped'`)),
    ]);
    return new Set([...favorites, ...copied].map((r) => r.address));
  }

  /** Never attempted rows (best pool rank first): the quick first pass
   * that gives every row its portfolio figures before any trade ledger. */
  async nextUnseen(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ address: discoveryTraders.address })
      .from(discoveryTraders)
      .where(and(mine, eq(discoveryTraders.inPool, true), isNull(discoveryTraders.attemptedAt)))
      .orderBy(sql`${discoveryTraders.poolRank} asc nulls last`, asc(discoveryTraders.address))
      .limit(limit);
    return rows.map((r) => r.address);
  }

  /** The next `limit` rows for a full refresh: no trade ledger yet first,
   * then the least recently refreshed; rows attempted within `backoffMs`
   * (a failure, or the quick pass just now) wait. */
  async nextBatch(limit: number, backoffMs: number, now = new Date()): Promise<Array<{ address: string; attemptedAt: Date | null; tradesAt: Date | null }>> {
    const since = new Date(now.getTime() - backoffMs);
    return this.db
      .select({ address: discoveryTraders.address, attemptedAt: discoveryTraders.attemptedAt, tradesAt: discoveryTraders.tradesAt })
      .from(discoveryTraders)
      .where(and(mine, eq(discoveryTraders.inPool, true), or(isNull(discoveryTraders.attemptedAt), lt(discoveryTraders.attemptedAt, since))))
      .orderBy(sql`${discoveryTraders.tradesAt} asc nulls first`, sql`${discoveryTraders.poolRank} asc nulls last`, asc(discoveryTraders.address))
      .limit(limit);
  }

  async save(address: string, figures: DiscoveryFigures): Promise<void> {
    await this.db.update(discoveryTraders).set(figures).where(and(mine, eq(discoveryTraders.address, address)));
  }

  async leaderboardAccountValue(address: string): Promise<number | null> {
    const [row] = await this.db
      .select({ accountValue: traderStats.accountValue })
      .from(traderStats)
      .where(and(eq(traderStats.chain, CHAIN_DEFAULT), eq(traderStats.address, address)))
      .limit(1);
    return row ? Number(row.accountValue) : null;
  }

  /** Per-coin realized figures of the stored closed trades (net of fees). */
  async coinAggregates(address: string): Promise<CoinAggregate[]> {
    const rows = await this.db
      .select({
        coin: traderTrades.coin,
        pnl: sql<string>`coalesce(sum(${traderTrades.netPnl}) filter (where ${traderTrades.exitTime} is not null), 0)`,
        volume: sql<string>`coalesce(sum(${traderTrades.entryNtl}), 0)`,
        trades: sql<number>`(count(*) filter (where ${traderTrades.exitTime} is not null))::int`,
        wins: sql<number>`(count(*) filter (where ${traderTrades.exitTime} is not null and ${traderTrades.netPnl} > 0))::int`,
      })
      .from(traderTrades)
      .where(and(eq(traderTrades.chain, CHAIN_DEFAULT), eq(traderTrades.address, address)))
      .groupBy(traderTrades.coin);
    return rows.map((r) => ({ coin: r.coin, pnl: Number(r.pnl), volume: Number(r.volume), trades: r.trades, wins: r.wins }));
  }

  /** Newest fill in the stored ledger. */
  async lastFillTime(address: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ last: sql<Date | null>`max(${traderTrades.lastFillTime})` })
      .from(traderTrades)
      .where(and(eq(traderTrades.chain, CHAIN_DEFAULT), eq(traderTrades.address, address)));
    return row?.last ? new Date(row.last) : null;
  }

  async analyticsState(address: string): Promise<{ classification: Record<string, unknown>; coverageFrom: Date | null; computedAt: Date } | undefined> {
    const [row] = await this.db
      .select({ classification: traderAnalytics.classification, coverageFrom: traderAnalytics.coverageFrom, computedAt: traderAnalytics.computedAt })
      .from(traderAnalytics)
      .where(and(eq(traderAnalytics.chain, CHAIN_DEFAULT), eq(traderAnalytics.address, address)))
      .limit(1);
    return row;
  }

  /** Every pool row with its KOL entry and leaderboard name (boards). */
  boardRows(): Promise<BoardSourceRow[]> {
    return this.selectBoardRows(and(mine, eq(discoveryTraders.inPool, true)));
  }

  /** The stored rows of these addresses, in or out of the pool (cards). */
  poolRowsOf(addresses: string[]): Promise<BoardSourceRow[]> {
    if (addresses.length === 0) return Promise.resolve([]);
    return this.selectBoardRows(and(mine, inArray(discoveryTraders.address, addresses)));
  }

  private async selectBoardRows(where: SQL | undefined): Promise<BoardSourceRow[]> {
    const rows = await this.db
      .select({
        row: discoveryTraders,
        kolName: kolTraders.displayName,
        kolAvatarEtag: sql<string | null>`case when ${kolAvatars.bytes} is null then null else ${kolAvatars.etag} end`,
        kolXHandle: kolTraders.xHandle,
        kolVerified: kolTraders.verified,
        kolSortOrder: kolTraders.sortOrder,
        leaderboardName: traderStats.displayName,
        leaderboardAccountValue: traderStats.accountValue,
        leaderboardVolumeMonth: traderStats.volumeMonth,
        leaderboardUpdatedAt: traderStats.updatedAt,
        archiveStatus: archiveCoverage.status,
      })
      .from(discoveryTraders)
      .leftJoin(kolTraders, and(eq(kolTraders.chain, discoveryTraders.chain), eq(kolTraders.address, discoveryTraders.address)))
      .leftJoin(kolAvatars, and(eq(kolAvatars.chain, discoveryTraders.chain), eq(kolAvatars.address, discoveryTraders.address)))
      .leftJoin(traderStats, and(eq(traderStats.chain, discoveryTraders.chain), eq(traderStats.address, discoveryTraders.address)))
      .leftJoin(archiveCoverage, and(eq(archiveCoverage.chain, discoveryTraders.chain), eq(archiveCoverage.address, discoveryTraders.address)))
      .where(where);
    const addresses = rows.map(({ row }) => row.address);
    if (addresses.length === 0) return [];
    const [history, watched] = await Promise.all([
      this.history.latestTimes(addresses),
      this.db.select({ address: fills.address, latest: sql<Date>`max(${fills.ts})` }).from(fills)
        .where(and(eq(fills.chain, CHAIN_DEFAULT), inArray(fills.address, addresses))).groupBy(fills.address),
    ]);
    const latest = new Map(watched.map(row => [row.address, new Date(row.latest)]));
    return rows.map(({ row, archiveStatus, ...rest }) => {
      const times = [row.lastTradeAt, history.get(row.address), latest.get(row.address)].filter((value): value is Date => value instanceof Date);
      return { ...row, ...rest, archiveExcluded: archiveStatus === "excluded", lastTradeAt: times.length ? new Date(Math.max(...times.map(time => time.getTime()))) : null };
    });
  }

  /** Leaderboard figures and KOL entries of these addresses (cards of
   * traders the pool has no figures for). */
  async identitiesOf(addresses: string[]): Promise<CardIdentityRow[]> {
    if (addresses.length === 0) return [];
    const [stats, kols] = await Promise.all([
      this.db
        .select({
          address: traderStats.address,
          displayName: traderStats.displayName,
          accountValue: traderStats.accountValue,
          pnlAllTime: traderStats.pnlAllTime,
          roiAllTime: traderStats.roiAllTime,
          pnlMonth: traderStats.pnlMonth,
          statsUpdatedAt: traderStats.updatedAt,
        })
        .from(traderStats)
        .where(and(eq(traderStats.chain, CHAIN_DEFAULT), inArray(traderStats.address, addresses))),
      this.db
        .select({
          address: kolTraders.address,
          kolName: kolTraders.displayName,
          kolXHandle: kolTraders.xHandle,
          kolVerified: kolTraders.verified,
          kolAvatarEtag: sql<string | null>`case when ${kolAvatars.bytes} is null then null else ${kolAvatars.etag} end`,
        })
        .from(kolTraders)
        .leftJoin(kolAvatars, and(eq(kolAvatars.chain, kolTraders.chain), eq(kolAvatars.address, kolTraders.address)))
        .where(and(eq(kolTraders.chain, CHAIN_DEFAULT), inArray(kolTraders.address, addresses))),
    ]);
    const byAddress = new Map<string, CardIdentityRow>();
    const empty = (address: string): CardIdentityRow => ({ address, displayName: null, accountValue: null, pnlAllTime: null, roiAllTime: null, pnlMonth: null, statsUpdatedAt: null, kolName: null, kolXHandle: null, kolVerified: null, kolAvatarEtag: null });
    for (const s of stats) byAddress.set(s.address, { ...empty(s.address), ...s });
    for (const k of kols) byAddress.set(k.address, { ...(byAddress.get(k.address) ?? empty(k.address)), ...k });
    return [...byAddress.values()];
  }

  /**
   * Addresses whose name matches `q` (the header search): KOL names and 𝕏
   * handles, leaderboard display names (substring, case-insensitive), or an
   * address starting with `q`. Each source is bounded by `perSource`
   * (leaderboard names by all-time PnL), so a one-letter query stays cheap.
   */
  async searchAddresses(q: string, perSource: number): Promise<string[]> {
    const text = `%${likeEscape(q)}%`;
    const prefix = /^0x[0-9a-f]*$/i.test(q) ? `${likeEscape(q.toLowerCase())}%` : null;
    const handle = q.replace(/^@/, "").replace(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i, "");
    const [kols, stats] = await Promise.all([
      this.db
        .select({ address: kolTraders.address })
        .from(kolTraders)
        .where(and(eq(kolTraders.chain, CHAIN_DEFAULT), or(
          ilike(kolTraders.displayName, text),
          handle ? ilike(kolTraders.xHandle, `%${likeEscape(handle)}%`) : undefined,
          prefix ? like(kolTraders.address, prefix) : undefined,
        )))
        .orderBy(asc(kolTraders.sortOrder), asc(kolTraders.address))
        .limit(perSource),
      this.db
        .select({ address: traderStats.address })
        .from(traderStats)
        .where(and(eq(traderStats.chain, CHAIN_DEFAULT), or(ilike(traderStats.displayName, text), prefix ? like(traderStats.address, prefix) : undefined)))
        .orderBy(sql`${traderStats.pnlAllTime} desc nulls last`, asc(traderStats.address))
        .limit(perSource),
    ]);
    return [...new Set([...kols, ...stats].map((r) => r.address))];
  }

  /** Pool size and how many rows have figures. */
  async coverage(): Promise<{ total: number; ready: number }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        ready: sql<number>`(count(*) filter (where ${discoveryTraders.portfolioAt} is not null))::int`,
      })
      .from(discoveryTraders)
      .where(and(mine, eq(discoveryTraders.inPool, true)));
    return row ?? { total: 0, ready: 0 };
  }

}
