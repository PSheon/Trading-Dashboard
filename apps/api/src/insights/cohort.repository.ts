import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { cohortMembers, cohortSnapshots, discoveryTraders, kolAvatars, kolTraders, traderAnalytics, traderStats, type CohortPosition } from "@trading-dashboard/shared/database";
import { CHAIN_DEFAULT, type CohortTier } from "@trading-dashboard/shared/contracts";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { COHORT_HISTORY_MIN_COVERAGE, COHORT_MAX_PERP_EQUITY, COHORT_TIERS, TIER_BOUNDS } from "./cohorts.js";

export type CohortMemberRow = typeof cohortMembers.$inferSelect;
export type CohortSnapshotRow = typeof cohortSnapshots.$inferSelect;

/** A candidate member before it is stored. */
export interface CohortCandidate {
  address: string;
  tier: CohortTier;
  source: "pool" | "leaderboard";
  rank: number;
  pnlAll: string | null;
  roiAll: string | null;
  /** Dexes the trader has traded on (from the pool's coin figures). */
  dexes: string[];
}

/** A member's identity for the wallet table. */
export interface CohortIdentityRow {
  address: string;
  kolName: string | null;
  kolVerified: boolean | null;
  kolAvatarEtag: string | null;
  leaderboardName: string | null;
  copyScore: number | null;
}

const mine = eq(cohortMembers.chain, CHAIN_DEFAULT);
const tierOrder = sql`array_position(array[${sql.join(COHORT_TIERS.map((t) => sql`${t}`), sql`, `)}]::text[], ${cohortMembers.tier})`;

function bounds(column: typeof discoveryTraders.pnlAll, tier: CohortTier): SQL | undefined {
  const b = TIER_BOUNDS[tier];
  return and(
    b.gte !== undefined ? gte(column, String(b.gte)) : undefined,
    b.gt !== undefined ? gt(column, String(b.gt)) : undefined,
    b.lt !== undefined ? lt(column, String(b.lt)) : undefined,
    b.lte !== undefined ? lte(column, String(b.lte)) : undefined,
    b.eq !== undefined ? eq(column, String(b.eq)) : undefined,
  );
}

/**
 * `cohort_members` and `cohort_snapshots` (Stage 3 §3), plus the reads that
 * choose members: the discovery pool (perp PnL, CopyDog's definition) and,
 * where a tier is short, the leaderboard. Single-statement writes; the
 * cohort job is the only writer.
 */
@Injectable()
export class CohortRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Pool rows with figures: address, perp PnL / ROI, account value (whole
   * account), the coins they traded, and what the eligibility rule reads
   * (`cohortEligible`): vault flag and perp equity (latest cohort snapshot,
   * else the ledger's classification). */
  poolFigures() {
    return this.db
      .select({
        address: discoveryTraders.address,
        pnlAll: discoveryTraders.pnlAll,
        roiAll: discoveryTraders.roiAll,
        accountValue: sql<string | null>`coalesce(${traderStats.accountValue}, ${discoveryTraders.accountValue})`,
        coinStats: discoveryTraders.coinStats,
        isVault: traderStats.isVault,
        perpEquity: sql<string | null>`coalesce(${cohortMembers.perpEquity}, case when jsonb_typeof(${traderAnalytics.classification}->'perpAccountValue') = 'number' then (${traderAnalytics.classification}->>'perpAccountValue')::numeric end)`,
      })
      .from(discoveryTraders)
      .leftJoin(traderStats, and(eq(traderStats.chain, discoveryTraders.chain), eq(traderStats.address, discoveryTraders.address)))
      .leftJoin(cohortMembers, and(eq(cohortMembers.chain, discoveryTraders.chain), eq(cohortMembers.address, discoveryTraders.address)))
      .leftJoin(traderAnalytics, and(eq(traderAnalytics.chain, discoveryTraders.chain), eq(traderAnalytics.address, discoveryTraders.address)))
      .where(and(eq(discoveryTraders.chain, CHAIN_DEFAULT), eq(discoveryTraders.inPool, true), isNotNull(discoveryTraders.pnlAll)));
  }

  /** Largest active non-vault accounts with known perp portfolio figures.
   * Never infer a perp tier from whole-account leaderboard PnL. Unknown
   * perp history stays excluded; a short tier remains visibly short. */
  async leaderboardTopUp(tier: CohortTier, limit: number, exclude: string[]): Promise<Array<{ address: string; pnlAll: string | null; roiAll: string | null }>> {
    if (limit <= 0) return [];
    return this.db
      .select({ address: traderStats.address, pnlAll: discoveryTraders.pnlAll, roiAll: discoveryTraders.roiAll })
      .from(traderStats)
      .innerJoin(discoveryTraders, and(eq(discoveryTraders.chain, traderStats.chain), eq(discoveryTraders.address, traderStats.address)))
      .leftJoin(traderAnalytics, and(eq(traderAnalytics.chain, traderStats.chain), eq(traderAnalytics.address, traderStats.address)))
      .where(and(
        eq(traderStats.chain, CHAIN_DEFAULT),
        eq(traderStats.isVault, false),
        // The perp-equity ceiling of `cohortEligible`, where the ledger knows it.
        sql`coalesce(case when jsonb_typeof(${traderAnalytics.classification}->'perpAccountValue') = 'number' then (${traderAnalytics.classification}->>'perpAccountValue')::numeric end, 0) <= ${COHORT_MAX_PERP_EQUITY}`,
        gt(traderStats.volumeMonth, "0"),
        gt(traderStats.accountValue, "0"),
        isNotNull(discoveryTraders.portfolioAt),
        bounds(discoveryTraders.pnlAll, tier),
        exclude.length > 0 ? notInArray(traderStats.address, exclude) : undefined,
      ))
      .orderBy(desc(traderStats.accountValue), asc(traderStats.address))
      .limit(limit);
  }

  /**
   * Makes the members exactly `candidates`: new ones are inserted (never
   * attempted, so they go first), existing ones keep their snapshot and get
   * their new tier / rank / figures, and the rest are deleted. One
   * transaction.
   */
  async sync(candidates: CohortCandidate[]): Promise<{ added: number; removed: number }> {
    return this.db.transaction(async (tx) => {
      const keep = candidates.map((c) => c.address);
      const removed = await tx
        .delete(cohortMembers)
        .where(keep.length > 0 ? and(mine, notInArray(cohortMembers.address, keep)) : mine)
        .returning({ address: cohortMembers.address });
      let added = 0;
      for (let i = 0; i < candidates.length; i += 500) {
        const batch = candidates.slice(i, i + 500);
        const rows = await tx
          .insert(cohortMembers)
          .values(batch.map((c) => ({ chain: CHAIN_DEFAULT, ...c })))
          .onConflictDoUpdate({
            target: [cohortMembers.chain, cohortMembers.address],
            set: {
              tier: sql`excluded.tier`,
              source: sql`excluded.source`,
              rank: sql`excluded.rank`,
              pnlAll: sql`excluded.pnl_all`,
              roiAll: sql`excluded.roi_all`,
              // Known dexes only grow here; a refresh prunes them.
              dexes: sql`(select coalesce(array_agg(distinct d), '{}') from unnest(${cohortMembers.dexes} || excluded.dexes) as d)`,
            },
          })
          .returning({ inserted: sql<boolean>`xmax = 0` });
        added += rows.filter((r) => r.inserted).length;
      }
      return { added, removed: removed.length };
    });
  }

  /** The next members to refresh: never attempted first (in tier order,
   * then rank), then those attempted longest ago before `before`. */
  nextDue(limit: number, before: Date): Promise<CohortMemberRow[]> {
    return this.db
      .select()
      .from(cohortMembers)
      .where(and(mine, sql`(${cohortMembers.attemptedAt} is null or ${cohortMembers.attemptedAt} < ${before})`))
      .orderBy(sql`${cohortMembers.attemptedAt} is not null`, asc(cohortMembers.attemptedAt), tierOrder, asc(cohortMembers.rank))
      .limit(limit);
  }

  async saveSnapshot(address: string, values: { positions: CohortPosition[]; perpEquity: number; dexes: string[]; fetchedAt: Date; sweptAt?: Date }): Promise<void> {
    await this.db
      .update(cohortMembers)
      .set({ ...values, perpEquity: String(values.perpEquity), attemptedAt: values.fetchedAt, lastError: null })
      .where(and(mine, eq(cohortMembers.address, address)));
  }

  async saveFailure(address: string, at: Date, error: string): Promise<void> {
    await this.db.update(cohortMembers).set({ attemptedAt: at, lastError: error }).where(and(mine, eq(cohortMembers.address, address)));
  }

  membersOf(tier: CohortTier): Promise<CohortMemberRow[]> {
    return this.db.select().from(cohortMembers).where(and(mine, eq(cohortMembers.tier, tier))).orderBy(asc(cohortMembers.rank));
  }

  /** Names, KOL badges, cached avatars and copy scores of these addresses. */
  async identities(addresses: string[]): Promise<CohortIdentityRow[]> {
    if (addresses.length === 0) return [];
    return this.db
      .select({
        address: cohortMembers.address,
        kolName: kolTraders.displayName,
        kolVerified: kolTraders.verified,
        kolAvatarEtag: sql<string | null>`case when ${kolAvatars.bytes} is null then null else ${kolAvatars.etag} end`,
        leaderboardName: traderStats.displayName,
        copyScore: discoveryTraders.copyScore,
      })
      .from(cohortMembers)
      .leftJoin(kolTraders, and(eq(kolTraders.chain, cohortMembers.chain), eq(kolTraders.address, cohortMembers.address)))
      .leftJoin(kolAvatars, and(eq(kolAvatars.chain, cohortMembers.chain), eq(kolAvatars.address, cohortMembers.address)))
      .leftJoin(traderStats, and(eq(traderStats.chain, cohortMembers.chain), eq(traderStats.address, cohortMembers.address)))
      .leftJoin(discoveryTraders, and(eq(discoveryTraders.chain, cohortMembers.chain), eq(discoveryTraders.address, cohortMembers.address)))
      .where(and(mine, inArray(cohortMembers.address, addresses)));
  }

  async insertSnapshot(values: Omit<typeof cohortSnapshots.$inferInsert, "id" | "chain">): Promise<void> {
    await this.db.insert(cohortSnapshots).values({ chain: CHAIN_DEFAULT, ...values });
  }

  /** Latest history row time per tier. */
  async lastSnapshotAt(): Promise<Map<string, Date>> {
    const rows = await this.db
      .select({ tier: cohortSnapshots.tier, ts: sql<Date>`max(${cohortSnapshots.ts})` })
      .from(cohortSnapshots)
      .where(eq(cohortSnapshots.chain, CHAIN_DEFAULT))
      .groupBy(cohortSnapshots.tier);
    return new Map(rows.map((r) => [r.tier, new Date(r.ts)]));
  }

  /** History rows of a tier since `since` (null: all), oldest first. Rows
   * recorded while less than COHORT_HISTORY_MIN_COVERAGE of the tier was
   * fresh are left out: each is the long share of part of the members, and a
   * missing whale moves it by tens of points (the chart's spikes). */
  history(tier: CohortTier, since: Date | null): Promise<Array<{ ts: Date; longPct: string | null; membershipVersion: string | null }>> {
    return this.db
      .select({ ts: cohortSnapshots.ts, longPct: cohortSnapshots.longPct, membershipVersion: cohortSnapshots.membershipVersion })
      .from(cohortSnapshots)
      .where(and(eq(cohortSnapshots.chain, CHAIN_DEFAULT), eq(cohortSnapshots.tier, tier), since ? gte(cohortSnapshots.ts, since) : undefined,
        sql`${cohortSnapshots.walletCount} >= ${COHORT_HISTORY_MIN_COVERAGE}::numeric * ${cohortSnapshots.memberCount}`))
      .orderBy(asc(cohortSnapshots.ts));
  }
}
