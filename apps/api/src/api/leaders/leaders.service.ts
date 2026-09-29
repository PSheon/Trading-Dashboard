import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, max } from "drizzle-orm";
import {
  CHAIN_DEFAULT,
  actions,
  alerts as alertsTable,
  equitySnapshots,
  fills,
  leaderListItems,
  leaderLists,
  leaders,
  positionSnapshots,
  type AlertEntry,
  type CoinDistributionEntry,
  type EquityInterval,
  type EquityPoint,
  type Fill,
  type Leader,
  type LeaderDetailResponse,
  type LeaderSummary,
  type LeadersQuery,
  type PatchLeaderRequest,
  type PositionRow,
} from "@trading-dashboard/shared";

import { RoundTripService } from "../../analytics/round-trip.service.js";
import type { AlertsScope } from "../alerts/alerts.service.js";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FILLS_HISTORY_LIMIT = 200;
const ALERTS_HISTORY_LIMIT = 50;
const EQUITY_CURVE_WINDOW_DAYS = 30;

/** D2 Leaders table + D3 Leader detail + A3 manual leader management. */
@Injectable()
export class LeadersService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly roundTrip: RoundTripService,
  ) {}

  async findAll(query: LeadersQuery): Promise<LeaderSummary[]> {
    const conditions = [eq(leaders.chain, CHAIN_DEFAULT)];
    if (query.tier) conditions.push(eq(leaders.tier, query.tier));
    if (query.active !== undefined) conditions.push(eq(leaders.active, query.active));

    const rows = await this.db
      .select()
      .from(leaders)
      .where(and(...conditions));

    // One leader at a time — table is capped at ~100 rows (PRD's whole
    // premise) and this runs on a 10s dashboard poll, not a hot path;
    // simplicity over a hand-rolled batch-SQL version for M2.
    return Promise.all(rows.map((row) => this.summarize(row as unknown as Leader)));
  }

  private async summarize(leader: Leader): Promise<LeaderSummary> {
    const now = new Date();
    const [rank, openPositionCount, pnl7d, pnl30d, winRate, avgHoldTimeSeconds, lastActionAt] =
      await Promise.all([
        this.latestRank(leader.address),
        this.openPositionCount(leader.chain, leader.address),
        this.roundTrip.realizedPnl(leader.address, new Date(now.getTime() - 7 * DAY_MS)),
        this.roundTrip.realizedPnl(leader.address, new Date(now.getTime() - 30 * DAY_MS)),
        this.roundTrip.winRate(leader.address, undefined, new Date(now.getTime() - 30 * DAY_MS)),
        this.roundTrip.avgHoldTimeSeconds(leader.address),
        this.lastActionAt(leader.chain, leader.address),
      ]);

    return {
      ...leader,
      rank,
      openPositionCount,
      pnl7d,
      pnl30d,
      winRate,
      avgHoldTimeSeconds,
      lastActionAt,
    };
  }

  /** Rank from the most recent `leader_list_items` row for this address
   * across every imported list version (§4.5 D2: "CopyDog 排名"). */
  private async latestRank(address: string): Promise<number | null> {
    const [row] = await this.db
      .select({ rank: leaderListItems.rank })
      .from(leaderListItems)
      .innerJoin(leaderLists, eq(leaderLists.id, leaderListItems.listId))
      .where(eq(leaderListItems.address, address))
      .orderBy(desc(leaderLists.importedAt))
      .limit(1);
    return row?.rank ?? null;
  }

  /** Current open-position count from `position_snapshots` (task's explicit
   * instruction: dashboard reads persisted snapshots, 5-minute staleness is
   * fine — never the Watcher's in-memory state, that's reserved for the
   * latency-critical Rules path). `writeSnapshots` in scheduler.service.ts
   * only ever inserts rows with `szi != 0`, so every row at the latest `ts`
   * is by construction an open position — no extra filter needed here. */
  private async openPositionCount(chain: string, address: string): Promise<number> {
    const [latest] = await this.db
      .select({ ts: max(positionSnapshots.ts) })
      .from(positionSnapshots)
      .where(and(eq(positionSnapshots.chain, chain), eq(positionSnapshots.address, address)));
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

  private async lastActionAt(chain: string, address: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ ts: actions.ts })
      .from(actions)
      .where(and(eq(actions.chain, chain), eq(actions.address, address)))
      .orderBy(desc(actions.ts))
      .limit(1);
    return row?.ts ?? null;
  }

  /** D3: current positions, fill history, self-stored equity curve, coin
   * distribution, and this address's alert history. */
  async findDetail(
    chain: string,
    address: string,
    equityInterval: EquityInterval,
    alertsScope: AlertsScope = "all",
  ): Promise<LeaderDetailResponse> {
    const [leader] = await this.db
      .select()
      .from(leaders)
      .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
      .limit(1);
    if (!leader) {
      throw new NotFoundException(`No leader ${chain}/${address}`);
    }

    const [rank, positions, fillsHistory, equityCurve, alertsHistory, winRate] = await Promise.all([
      this.latestRank(address),
      this.currentPositions(chain, address),
      this.fillsHistory(chain, address),
      this.equityCurve(chain, address, equityInterval),
      this.alertsHistory(address, alertsScope),
      this.roundTrip.winRate(address, undefined, new Date(Date.now() - 30 * DAY_MS)),
    ]);

    const coinDistribution = this.coinDistributionFrom(positions);

    return {
      leader: leader as unknown as Leader,
      rank,
      positions,
      fills: fillsHistory,
      equityCurve,
      coinDistribution,
      alerts: alertsHistory,
      winRate,
    };
  }

  private async currentPositions(chain: string, address: string): Promise<PositionRow[]> {
    const [latest] = await this.db
      .select({ ts: max(positionSnapshots.ts) })
      .from(positionSnapshots)
      .where(and(eq(positionSnapshots.chain, chain), eq(positionSnapshots.address, address)));
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

  private coinDistributionFrom(positions: PositionRow[]): CoinDistributionEntry[] {
    const notionalByCoin = new Map<string, number>();
    let total = 0;
    for (const p of positions) {
      if (p.entryPx === null) continue;
      const notional = Math.abs(Number(p.szi)) * Number(p.entryPx);
      notionalByCoin.set(p.coin, (notionalByCoin.get(p.coin) ?? 0) + notional);
      total += notional;
    }
    return [...notionalByCoin.entries()].map(([coin, notionalUsd]) => ({
      coin,
      notionalUsd,
      shareOfTotal: total === 0 ? 0 : notionalUsd / total,
    }));
  }

  private async fillsHistory(chain: string, address: string): Promise<Fill[]> {
    const rows = await this.db
      .select()
      .from(fills)
      .where(and(eq(fills.chain, chain), eq(fills.address, address)))
      .orderBy(desc(fills.ts))
      .limit(FILLS_HISTORY_LIMIT);
    return rows as unknown as Fill[];
  }

  /** §11 決策紀錄 "權益曲線顯示": stored at a flat 5-minute grain always;
   * the default detail-page view downsamples to one point per hour, with a
   * toggle to the raw 5-minute series — "儲存不降採樣，顯示才降". Downsampling
   * happens here (last snapshot in each hour bucket) rather than as a
   * second stored table, since the raw series stays cheap at this data
   * volume (one address, 30 days, 5-minute grain = ~8,640 rows). */
  private async equityCurve(chain: string, address: string, interval: EquityInterval): Promise<EquityPoint[]> {
    const since = new Date(Date.now() - EQUITY_CURVE_WINDOW_DAYS * DAY_MS);
    const rows = await this.db
      .select({ ts: equitySnapshots.ts, accountValue: equitySnapshots.accountValue })
      .from(equitySnapshots)
      .where(and(eq(equitySnapshots.chain, chain), eq(equitySnapshots.address, address)))
      .orderBy(equitySnapshots.ts);

    const windowed = rows.filter((r) => r.ts >= since);
    if (interval === "5m") return windowed;

    const byHour = new Map<string, (typeof windowed)[number]>();
    for (const row of windowed) {
      const bucket = new Date(row.ts);
      bucket.setUTCMinutes(0, 0, 0);
      byHour.set(bucket.toISOString(), row); // last row wins per bucket
    }
    return [...byHour.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  private async alertsHistory(address: string, scope: AlertsScope): Promise<AlertEntry[]> {
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

  /** A3: update label/tier/notes/active. `active=false` alone is what
   * stops polling/snapshots — the Watcher re-reads `leaders` fresh every
   * cycle and filters on `active=true` there, so there's nothing else to
   * wire up here for that half of the acceptance criterion. */
  async update(chain: string, address: string, patch: PatchLeaderRequest): Promise<Leader> {
    const [updated] = await this.db
      .update(leaders)
      .set(patch)
      .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
      .returning();

    if (!updated) {
      throw new NotFoundException(`No leader ${chain}/${address}`);
    }
    return updated as unknown as Leader;
  }
}
