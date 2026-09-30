import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  leaders,
  kolTraders,
  traderStats,
  discoveryTraders,
  userFavorites,
  leaderLists,
  leaderListItems,
  fills,
  traderAnalytics,
  analysisHistoryJobs,
  backfillJobs,
} from "@trading-dashboard/shared/database";
import type { AdminTrader } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
@Injectable()
export class AdminTraderRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  /** Stored evidence only. No Hyperliquid client or work-admission dependency. */
  async detail(address: string): Promise<AdminTrader> {
    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
        const sampledAt = new Date().toISOString();
        const [kol] = await tx
          .select({
            displayName: kolTraders.displayName,
            xHandle: kolTraders.xHandle,
          })
          .from(kolTraders)
          .where(
            and(
              eq(kolTraders.chain, "hyperliquid"),
              eq(kolTraders.address, address),
            ),
          );
        const [stats] = await tx
          .select({
            displayName: traderStats.displayName,
            updatedAt: traderStats.updatedAt,
          })
          .from(traderStats)
          .where(
            and(
              eq(traderStats.chain, "hyperliquid"),
              eq(traderStats.address, address),
            ),
          );
        const [watch] = await tx
          .select({
            active: leaders.active,
            source: leaders.source,
            firstSeenAt: leaders.firstSeenAt,
          })
          .from(leaders)
          .where(
            and(eq(leaders.chain, "hyperliquid"), eq(leaders.address, address)),
          );
        const [pool] = await tx
          .select({
            inPool: discoveryTraders.inPool,
            poolRank: discoveryTraders.poolRank,
            portfolioAt: discoveryTraders.portfolioAt,
            tradesAt: discoveryTraders.tradesAt,
            attemptedAt: discoveryTraders.attemptedAt,
            refreshFailed: sql<boolean>`${discoveryTraders.lastError} IS NOT NULL`,
          })
          .from(discoveryTraders)
          .where(
            and(
              eq(discoveryTraders.chain, "hyperliquid"),
              eq(discoveryTraders.address, address),
            ),
          );
        const [references] = await tx
          .select({
            favorites: sql<number>`count(*)::int`,
            alerts: sql<number>`count(*) FILTER (WHERE ${userFavorites.alertEnabled})::int`,
          })
          .from(userFavorites)
          .where(
            and(
              eq(userFavorites.chain, "hyperliquid"),
              eq(userFavorites.address, address),
            ),
          );
        const imports = await tx
          .select({
            id: leaderLists.id,
            source: leaderLists.source,
            importedAt: leaderLists.importedAt,
            rank: leaderListItems.rank,
          })
          .from(leaderListItems)
          .innerJoin(leaderLists, eq(leaderLists.id, leaderListItems.listId))
          .where(eq(leaderListItems.address, address))
          .orderBy(desc(leaderLists.id))
          .limit(21);
        const [range] = await tx
          .select({
            firstAt: sql<Date | null>`min(${fills.ts})`.mapWith(fills.ts),
            lastAt: sql<Date | null>`max(${fills.ts})`.mapWith(fills.ts),
          })
          .from(fills)
          .where(
            and(eq(fills.chain, "hyperliquid"), eq(fills.address, address)),
          );
        const [analytics] = await tx
          .select({
            source: traderAnalytics.source,
            coverageFrom: traderAnalytics.coverageFrom,
            historyThrough: traderAnalytics.historyThrough,
            computedAt: traderAnalytics.computedAt,
            truncated: traderAnalytics.truncated,
            fillsRead: traderAnalytics.fillsRead,
            fundingFrom: traderAnalytics.fundingFrom,
            fundingThrough: traderAnalytics.fundingCursor,
          })
          .from(traderAnalytics)
          .where(
            and(
              eq(traderAnalytics.chain, "hyperliquid"),
              eq(traderAnalytics.address, address),
            ),
          );
        const [history] = await tx
          .select({
            status: analysisHistoryJobs.status,
            publishedThrough: analysisHistoryJobs.publishedThrough,
            attemptedAt: analysisHistoryJobs.attemptedAt,
            failed: sql<boolean>`${analysisHistoryJobs.lastError} IS NOT NULL`,
          })
          .from(analysisHistoryJobs)
          .where(
            and(
              eq(analysisHistoryJobs.chain, "hyperliquid"),
              eq(analysisHistoryJobs.address, address),
            ),
          );
        const [backfill] = await tx
          .select({
            id: backfillJobs.id,
            status: backfillJobs.status,
            attempts: backfillJobs.attempts,
            availableAt: backfillJobs.availableAt,
            completedAt: backfillJobs.completedAt,
          })
          .from(backfillJobs)
          .where(
            and(
              eq(backfillJobs.chain, "hyperliquid"),
              eq(backfillJobs.address, address),
            ),
          );
        return {
          chain: "hyperliquid",
          address,
          sampledAt,
          identity: {
            displayName: kol?.displayName ?? stats?.displayName ?? null,
            xHandle: kol?.xHandle ?? null,
            kolRegistered: Boolean(kol),
            leaderboardUpdatedAt: iso(stats?.updatedAt),
          },
          watch: watch
            ? { ...watch, firstSeenAt: watch.firstSeenAt.toISOString() }
            : null,
          discovery: pool
            ? {
                ...pool,
                portfolioAt: iso(pool.portfolioAt),
                tradesAt: iso(pool.tradesAt),
                attemptedAt: iso(pool.attemptedAt),
              }
            : null,
          references,
          imports: {
            items: imports
              .slice(0, 20)
              .map((r) => ({ ...r, importedAt: r.importedAt.toISOString() })),
            hasMore: imports.length > 20,
          },
          fills: { firstAt: iso(range.firstAt), lastAt: iso(range.lastAt) },
          analytics: analytics
            ? {
                ...analytics,
                computedAt: analytics.computedAt.toISOString(),
                coverageFrom: iso(analytics.coverageFrom),
                historyThrough: iso(analytics.historyThrough),
                fundingFrom: iso(analytics.fundingFrom),
                fundingThrough: iso(analytics.fundingThrough),
              }
            : null,
          history: history
            ? {
                ...history,
                publishedThrough: iso(history.publishedThrough),
                attemptedAt: iso(history.attemptedAt),
              }
            : null,
          backfill: backfill
            ? {
                ...backfill,
                availableAt: backfill.availableAt.toISOString(),
                completedAt: iso(backfill.completedAt),
              }
            : null,
        };
      },
      { accessMode: "read only", isolationLevel: "repeatable read" },
    );
  }
}
