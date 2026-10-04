import { Injectable, NotFoundException } from "@nestjs/common";
import { copyEventsQuerySchema, copyPerformanceQuerySchema, copyPortfolioQuerySchema, copyTradesQuerySchema, type CopyEventsResponse, type CopyPerformanceResponse, type CopyPerformanceWindow, type CopyPortfolioResponse, type CopyTradesResponse } from "@trading-dashboard/shared/contracts";
import { Dec } from "../common/decimal/dec.js";
import { parseOr400 } from "../common/http/validation.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { CopyMarketService, MIDS_TTL_MS } from "./copy-market.service.js";
import { wire } from "./copy.mappers.js";
import { strategyValue } from "./copy-planner.service.js";
import { CopyRepository } from "./copy.repository.js";

export const COPY_SNAPSHOT_INTERVAL_MS = 60_000;
const FRESH_MS = 2 * COPY_SNAPSHOT_INTERVAL_MS;
/** The portfolio chart's resolution: about this many intervals per window. */
export const PORTFOLIO_POINTS = 120;
export const SPARKLINE_POINTS = 48;
const WINDOW_MS: Record<Exclude<CopyPerformanceWindow, "all">, number> = { "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

@Injectable()
export class CopyPerformanceService {
  constructor(private readonly repository: CopyRepository, private readonly uow: UnitOfWork, private readonly market: CopyMarketService) {}

  /** Each strategy commits an exact internally consistent valuation. Network
   * reads are outside the transaction; absent prices are persisted as null. */
  async capture(): Promise<void> {
    const rows = await this.repository.runtime.activeStrategies();
    if (rows.length === 0) return;
    const coins = await this.repository.positionCoins(rows.map((r) => r.id));
    for (const { id } of rows) {
      const mids = coins.length ? await this.market.midPrices(coins) : null;
      await this.uow.run(async (tx) => {
        const strategy = await this.repository.lockStrategy(tx, id);
        if (!strategy || strategy.status === "stopped") return;
        const positions = await this.repository.positionsOf([id], tx);
        // Timestamp the locked state, not the batch start or minute boundary.
        const now = Date.now();
        const time = new Date(now);
        const marks = mids && mids.at.getTime() <= now && now - mids.at.getTime() <= MIDS_TTL_MS ? mids : null;
        const value = strategyValue(strategy, positions, marks);
        const netDeposits = Dec.from(strategy.allocated).sub(strategy.withdrawn);
        await this.repository.runtime.snapshot(tx, {
          strategyId: id, time, equity: value.equity?.toString() ?? null,
          totalPnl: value.equity?.sub(netDeposits).toString() ?? null, netDeposits: netDeposits.toString(), exposureUsd: value.exposure?.toString() ?? null,
        });
      });
    }
  }

  async history(userId: number, strategyId: number, query: unknown): Promise<CopyPerformanceResponse> {
    const { window } = parseOr400(copyPerformanceQuerySchema, query);
    const row = await this.repository.strategyWithSettings(strategyId);
    if (!row || row.strategy.userId !== userId) throw new NotFoundException("Copy not found");
    const strategy = row.strategy;
    const to = strategy.stoppedAt ?? new Date();
    const duration = window === "1d" ? 86_400_000 : window === "7d" ? 7 * 86_400_000 : window === "30d" ? 30 * 86_400_000 : to.getTime() - strategy.createdAt.getTime();
    const from = new Date(Math.max(strategy.createdAt.getTime(), to.getTime() - duration));
    // Bound history independently of strategy age; retain missing marks and gaps.
    const bucketMs = Math.max(60_000, Math.ceil((to.getTime() - from.getTime()) / 1000 / 60_000) * 60_000);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const baselineTime = new Date(Math.max(today.getTime(), strategy.createdAt.getTime()));
    const { sampled, first, last, windowFirst, maxGap, baseline } = await this.repository.runtime.performance(strategyId, from, to, baselineTime, bucketMs, FRESH_MS);
    const points = sampled.map((r) => ({
      time: new Date(r.time as string | Date), equity: r.missing || r.equity === null ? null : wire(r.equity as string),
      totalPnl: r.missing || r.total_pnl === null ? null : wire(r.total_pnl as string),
      netDeposits: wire(r.net_deposits as string), exposureUsd: r.missing || r.exposure_usd === null ? null : wire(r.exposure_usd as string),
    }));
    const baselineValid = baseline && baselineTime.getTime() - baseline.time.getTime() <= FRESH_MS;
    const fresh = last && to.getTime() - last.time.getTime() <= FRESH_MS;
    const todayPnl = strategy.stoppedAt && strategy.stoppedAt.getTime() < today.getTime() ? 0 : baselineValid && fresh && baseline.totalPnl !== null && last.totalPnl !== null
      ? wire(Dec.from(last.totalPnl).sub(baseline.totalPnl)) : null;
    const complete = Boolean(first && windowFirst && fresh && windowFirst.time.getTime() <= from.getTime() + COPY_SNAPSHOT_INTERVAL_MS
      && maxGap <= FRESH_MS && points.every((p) => p.equity !== null));
    return { strategyId, mode: "paper", window, from, to, points, todayPnl,
      coverage: { firstSnapshotAt: first?.time ?? null, lastSnapshotAt: last?.time ?? null, complete } };
  }

  /**
   * The whole paper portfolio (CopyDog's `hl-portfolio/chart`): every copy
   * the owner ever ran, merged. The window starts no earlier than the first
   * copy; `todayPnl` is since 00:00 UTC (as each copy's own today figure).
   */
  async portfolio(userId: number, query: unknown, now = new Date()): Promise<CopyPortfolioResponse> {
    const { window } = parseOr400(copyPortfolioQuerySchema, query);
    const first = await this.repository.runtime.firstCopyAt(userId);
    const to = now;
    const start = window === "all" ? (first ?? to) : new Date(to.getTime() - WINDOW_MS[window]);
    const from = new Date(Math.min(to.getTime(), Math.max(start.getTime(), first?.getTime() ?? to.getTime())));
    const stepMs = Math.max(COPY_SNAPSHOT_INTERVAL_MS, Math.ceil((to.getTime() - from.getTime()) / PORTFOLIO_POINTS / 1000) * 1000);
    const [rows, sparks, today] = await Promise.all([
      first ? this.repository.runtime.portfolioSeries(userId, from, to, stepMs, FRESH_MS) : Promise.resolve([]),
      this.repository.runtime.sparklines(userId, SPARKLINE_POINTS, FRESH_MS),
      this.todayPnl(userId, now),
    ]);
    const points = rows.map((r) => ({ time: r.time, pnl: r.missing ? null : wire(r.pnl) }));
    return {
      mode: "paper", window, from, to, points, partial: points.some((p) => p.pnl === null), todayPnl: today,
      sparklines: [...sparks.entries()].map(([strategyId, values]) => ({ strategyId, points: values.map((v) => (v === null ? null : wire(v))) })),
    };
  }

  /** Change since 00:00 UTC over every copy that ran today: null while any
   * of them has no valuation at the day's start or now. */
  private async todayPnl(userId: number, now: Date): Promise<number | null> {
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const rows = await this.repository.runtime.todayInputs(userId, dayStart);
    let sum = Dec.from(0);
    for (const r of rows) {
      const stopped = r.stoppedAt !== null && r.stoppedAt.getTime() <= now.getTime();
      const base = r.createdAt.getTime() >= dayStart.getTime() ? "0"
        : r.baseTime && r.basePnl !== null && dayStart.getTime() - r.baseTime.getTime() <= FRESH_MS ? r.basePnl : null;
      const last = r.lastTime && r.lastPnl !== null && (stopped || now.getTime() - r.lastTime.getTime() <= FRESH_MS) ? r.lastPnl
        : !r.lastTime && now.getTime() - r.createdAt.getTime() <= FRESH_MS ? "0" : null;
      if (base === null || last === null) return null;
      sum = sum.add(Dec.from(last).sub(base));
    }
    return wire(sum);
  }

  /** Closed copy trades (best, worst or latest), from the copies' fills. */
  async trades(userId: number, query: unknown): Promise<CopyTradesResponse> {
    const { sort, limit, strategyId, id } = parseOr400(copyTradesQuerySchema, query);
    const rows = await this.repository.runtime.closedTrades(userId, sort, limit, strategyId, id);
    return {
      mode: "paper",
      items: rows.map((r) => {
        const entryNotional = Dec.from(r.entryNotional);
        const net = Dec.from(r.net);
        return {
          id: r.openId, strategyId: r.strategyId, leaderAddress: r.leaderAddress, coin: r.coin,
          side: Dec.from(r.firstSigned).isPositive ? "long" as const : "short" as const,
          size: wire(r.entrySize), entryPx: wire(entryNotional.div(r.entrySize)), exitPx: wire(Dec.from(r.exitNotional).div(r.exitSize)),
          entryNotional: wire(entryNotional), pnl: wire(net), fees: wire(r.fees),
          roiPct: entryNotional.isPositive ? wire(net.div(entryNotional).mul(100)) : null,
          openedAt: r.openedAt, closedAt: r.closedAt,
        };
      }),
    };
  }

  async events(userId: number, query: unknown): Promise<CopyEventsResponse> {
    const { after, before, limit } = parseOr400(copyEventsQuerySchema, query);
    const rows = await this.repository.runtime.events(userId, BigInt(after), limit + 1, before ? BigInt(before) : undefined);
    const items = rows.slice(0, limit);
    if (after === "0" || before) items.reverse();
    return { items: items.map((r) => ({ ...r, id: String(r.id) })),
      nextCursor: items.length ? String(items[items.length - 1]!.id) : after,
      previousCursor: items.length ? String(items[0]!.id) : null, hasMore: rows.length > limit };
  }
}
