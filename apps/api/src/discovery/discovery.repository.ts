import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, isNotNull, notInArray, sql } from "drizzle-orm";
import { discoveryTraders, kolTraders, traderAnalytics, traderStats, traderTrades } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";

export type DiscoveryRow = typeof discoveryTraders.$inferSelect;
export type DiscoveryFigures = Partial<Omit<typeof discoveryTraders.$inferInsert, "chain" | "address" | "poolRank" | "inPool">>;

/** A pool row with the KOL entry and leaderboard name it is shown with. */
export interface BoardSourceRow extends DiscoveryRow {
  kolName: string | null;
  kolAvatarUrl: string | null;
  kolXHandle: string | null;
  kolVerified: boolean | null;
  kolSortOrder: number | null;
  leaderboardName: string | null;
  /** Leaderboard account value (free, refreshed with every import). */
  leaderboardAccountValue: string | null;
}

export interface CoinAggregate {
  coin: string;
  pnl: number;
  volume: number;
  trades: number;
  wins: number;
}

const mine = eq(discoveryTraders.chain, CHAIN_DEFAULT);

/**
 * `discovery_traders` (the pool's cached figures) plus the reads the pool
 * job needs from `trader_stats`, `kol_traders` and the trade ledger.
 */
@Injectable()
export class DiscoveryRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

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

  /** The next `limit` rows to refresh: never attempted first (best pool
   * rank first), then the least recently attempted. */
  async nextBatch(limit: number): Promise<Array<{ address: string; attemptedAt: Date | null; tradesAt: Date | null }>> {
    return this.db
      .select({ address: discoveryTraders.address, attemptedAt: discoveryTraders.attemptedAt, tradesAt: discoveryTraders.tradesAt })
      .from(discoveryTraders)
      .where(and(mine, eq(discoveryTraders.inPool, true)))
      .orderBy(sql`${discoveryTraders.attemptedAt} asc nulls first`, sql`${discoveryTraders.poolRank} asc nulls last`, asc(discoveryTraders.address))
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

  async analyticsState(address: string): Promise<{ classification: Record<string, unknown>; coverageFrom: Date | null } | undefined> {
    const [row] = await this.db
      .select({ classification: traderAnalytics.classification, coverageFrom: traderAnalytics.coverageFrom })
      .from(traderAnalytics)
      .where(and(eq(traderAnalytics.chain, CHAIN_DEFAULT), eq(traderAnalytics.address, address)))
      .limit(1);
    return row;
  }

  /** Every pool row with its KOL entry and leaderboard name (boards). */
  async boardRows(): Promise<BoardSourceRow[]> {
    const rows = await this.db
      .select({
        row: discoveryTraders,
        kolName: kolTraders.displayName,
        kolAvatarUrl: kolTraders.avatarUrl,
        kolXHandle: kolTraders.xHandle,
        kolVerified: kolTraders.verified,
        kolSortOrder: kolTraders.sortOrder,
        leaderboardName: traderStats.displayName,
        leaderboardAccountValue: traderStats.accountValue,
      })
      .from(discoveryTraders)
      .leftJoin(kolTraders, and(eq(kolTraders.chain, discoveryTraders.chain), eq(kolTraders.address, discoveryTraders.address)))
      .leftJoin(traderStats, and(eq(traderStats.chain, discoveryTraders.chain), eq(traderStats.address, discoveryTraders.address)))
      .where(and(mine, eq(discoveryTraders.inPool, true)));
    return rows.map(({ row, ...rest }) => ({ ...row, ...rest }));
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

  /** The stored copy score of a pool member (null when absent). */
  async copyScoreOf(address: string): Promise<number | null> {
    const [row] = await this.db
      .select({ copyScore: discoveryTraders.copyScore })
      .from(discoveryTraders)
      .where(and(mine, eq(discoveryTraders.address, address), isNotNull(discoveryTraders.copyScore)))
      .limit(1);
    return row?.copyScore ?? null;
  }
}
