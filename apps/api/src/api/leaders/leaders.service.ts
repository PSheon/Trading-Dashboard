import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  CoinDistributionEntry,
  EquityInterval,
  EquityPoint,
  Leader,
  LeaderDetailResponse,
  LeaderSummary,
  LeadersQuery,
  PatchLeaderRequest,
  PositionRow,
} from "@trading-dashboard/shared/contracts";
import { LeadersRepository } from "./leaders.repository.js";
import { RoundTripService } from "../../analytics/round-trip.service.js";
import type { AlertsScope } from "../../common/auth/alerts-scope.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const EQUITY_CURVE_WINDOW_DAYS = 30;

/** D2 Leaders table + D3 Leader detail + A3 manual leader management. */
@Injectable()
export class LeadersService {
  constructor(
    private readonly repository: LeadersRepository,
    private readonly roundTrip: RoundTripService,
  ) {}

  async findAll(query: LeadersQuery): Promise<LeaderSummary[]> {
    const rows = await this.repository.findListed(query);

    // Aggregation remains here; query batching is tracked in the performance task.
    return Promise.all(rows.map((row) => this.summarize(row as unknown as Leader)));
  }

  private async summarize(leader: Leader): Promise<LeaderSummary> {
    const now = new Date();
    const [rank, openPositionCount, pnl7d, pnl30d, winRate, avgHoldTimeSeconds, lastActionAt] =
      await Promise.all([
        this.repository.latestRank(leader.address),
        this.repository.openPositionCount(leader.chain, leader.address),
        this.roundTrip.realizedPnl(leader.address, new Date(now.getTime() - 7 * DAY_MS)),
        this.roundTrip.realizedPnl(leader.address, new Date(now.getTime() - 30 * DAY_MS)),
        this.roundTrip.winRate(leader.address, undefined, new Date(now.getTime() - 30 * DAY_MS)),
        this.roundTrip.avgHoldTimeSeconds(leader.address),
        this.repository.lastActionAt(leader.chain, leader.address),
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

  /** D3: current positions, fill history, self-stored equity curve, coin
   * distribution, and this address's alert history. */
  async findDetail(
    chain: string,
    address: string,
    equityInterval: EquityInterval,
    alertsScope: AlertsScope = "all",
  ): Promise<LeaderDetailResponse> {
    const leader = await this.repository.findOne(chain, address);
    if (!leader) {
      throw new NotFoundException(`No leader ${chain}/${address}`);
    }

    const [rank, positions, fillsHistory, equityCurve, alertsHistory, winRate] = await Promise.all([
      this.repository.latestRank(address),
      this.repository.currentPositions(chain, address),
      this.repository.fillsHistory(chain, address),
      this.equityCurve(chain, address, equityInterval),
      this.repository.alertsHistory(address, alertsScope),
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

  /** §11 決策紀錄 "權益曲線顯示": stored at a flat 5-minute grain always;
   * the default detail-page view downsamples to one point per hour, with a
   * toggle to the raw 5-minute series — "儲存不降採樣，顯示才降". Downsampling
   * happens here (last snapshot in each hour bucket) rather than as a
   * second stored table, since the raw series stays cheap at this data
   * volume (one address, 30 days, 5-minute grain = ~8,640 rows). */
  private async equityCurve(chain: string, address: string, interval: EquityInterval): Promise<EquityPoint[]> {
    const since = new Date(Date.now() - EQUITY_CURVE_WINDOW_DAYS * DAY_MS);
    const rows = await this.repository.equityRows(chain, address, since);

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

  /** A3: update label/tier/notes/active. `active=false` alone is what
   * stops polling/snapshots — the Watcher re-reads `leaders` fresh every
   * cycle and filters on `active=true` there, so there's nothing else to
   * wire up here for that half of the acceptance criterion. */
  async update(chain: string, address: string, patch: PatchLeaderRequest): Promise<Leader> {
    const updated = await this.repository.update(chain, address, patch);

    if (!updated) {
      throw new NotFoundException(`No leader ${chain}/${address}`);
    }
    return updated as unknown as Leader;
  }
}
