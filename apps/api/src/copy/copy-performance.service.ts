import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { copyEventsQuerySchema, copyPerformanceQuerySchema, copyPortfolioQuerySchema, copyTradesQuerySchema, type CopyEventsResponse, type CopyPerformanceResponse, type CopyPerformanceWindow, type CopyPortfolioResponse, type CopyTradesResponse } from "@trading-dashboard/shared/contracts";
import { Dec } from "../common/decimal/dec.js";
import { parseOr400 } from "../common/http/validation.js";
import { AppConfig } from "../config/app-config.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { deploymentNetwork } from "./live-deployment.js";
import type { LiveAccountSnapshot } from "./live/live-account-observer.js";
import { mapLiveAccountView } from "./live/live-account-view.js";
import { CopyMarketService, MIDS_TTL_MS } from "./copy-market.service.js";
import { wire } from "./copy.mappers.js";
import { strategyValue } from "./copy-planner.service.js";
import { CopyRepository } from "./copy.repository.js";

export const COPY_SNAPSHOT_INTERVAL_MS = 60_000;
const FRESH_MS = 2 * COPY_SNAPSHOT_INTERVAL_MS;
/** An actual copy is valued at each stored observation of its account, which
 * the follower collector takes at most every two minutes per account (five
 * while testnet orders are busy), not every minute: a gap up to this is not a
 * hole in its history. */
export const ACTUAL_FRESH_MS = 6 * COPY_SNAPSHOT_INTERVAL_MS;
/** The portfolio chart's resolution: about this many intervals per window. */
export const PORTFOLIO_POINTS = 120;
export const SPARKLINE_POINTS = 48;
const WINDOW_MS: Record<Exclude<CopyPerformanceWindow, "all">, number> = { "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

type ActualTransfer = { direction: "to_account" | "to_main"; status: string; amount: string; creditedAmount: string | null;
  attemptedAt: Date | null; createdAt: Date; updatedAt: Date };

/**
 * What the owner had put into an actual copy's account as of `at`: deposits
 * credited minus returns credited (a return takes its whole amount, fee
 * included, from the account). Null when that is unknown at `at`: a transfer
 * was sent by then but not yet recorded as credited by then. Transfers not
 * sent by `at` (never attempted, cancelled, rejected, or attempted later)
 * have not moved money the observation could show.
 */
export function actualNetDeposits(transfers: readonly ActualTransfer[], at: number): Dec | null {
  let net = Dec.from(0);
  for (const t of transfers) {
    if (t.status === "cancelled" || t.status === "rejected" || !t.attemptedAt || t.attemptedAt.getTime() > at || t.createdAt.getTime() > at) continue;
    if (t.status !== "credited" || t.updatedAt.getTime() > at || !t.creditedAmount) return null;
    net = t.direction === "to_account" ? net.add(t.creditedAmount) : net.sub(t.amount);
  }
  return net;
}

@Injectable()
export class CopyPerformanceService {
  private readonly logger = new Logger(CopyPerformanceService.name);
  constructor(private readonly repository: CopyRepository, private readonly uow: UnitOfWork, private readonly market: CopyMarketService,
    private readonly config: AppConfig) {}

  async capture(): Promise<void> {
    await this.capturePaper();
    await this.captureActual();
  }

  /**
   * Actual copies of this deployment's network: one valuation per stored
   * follower observation, at its own time (the collector's reads only; none
   * here). Equity is the observed account value; exposure the observed
   * positions' value. Nothing is written without a valid observation or
   * while net deposits are unknown (never a zero or a guess).
   */
  private async captureActual(): Promise<void> {
    const network = deploymentNetwork(this.config);
    for (const row of await this.repository.runtime.actualSnapshotInputs(network)) {
      try {
        const o = row.observation, snapshot = o.snapshot as unknown as LiveAccountSnapshot;
        if (!row.account.address || snapshot.sourceDigest !== o.sourceDigest || snapshot.observedAt !== o.observedAt.getTime() ||
            snapshot.completedAt !== o.completedAt.getTime() || snapshot.coverage.earliestProviderTime !== o.earliestProviderTime.getTime()) continue;
        // Valid and fresh as of its own completion (the snapshot GET's rules).
        const view = mapLiveAccountView({ accountId: row.account.id, strategyId: row.strategyId, network, accountAddress: row.account.address },
          snapshot, { blocked: false, reason: null }, snapshot.completedAt, 5000);
        const netDeposits = actualNetDeposits(row.transfers, snapshot.observedAt);
        if (!netDeposits) continue;
        const equity = Dec.from(view.metrics.perpEquity);
        await this.repository.runtime.actualSnapshot({ strategyId: row.strategyId, time: new Date(snapshot.observedAt), equity: equity.toString(),
          totalPnl: equity.sub(netDeposits).toString(), netDeposits: netDeposits.toString(),
          exposureUsd: Dec.sum(view.positions.map((p) => Dec.from(p.positionValue).abs())).toString() });
      } catch (error) {
        this.logger.warn(`Actual copy ${row.strategyId} valuation skipped (${safeErrorText(error)})`);
      }
    }
  }

  /** Each strategy commits an exact internally consistent valuation. Network
   * reads are outside the transaction; absent prices are persisted as null. */
  private async capturePaper(): Promise<void> {
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
    const strategy = await this.repository.runtime.performanceStrategy(strategyId);
    if (!strategy || strategy.userId !== userId) throw new NotFoundException("Copy not found");
    const actual = strategy.mode !== "paper";
    // An actual copy of another network is shown as its stored history.
    const freshMs = actual ? ACTUAL_FRESH_MS : FRESH_MS, stepMs = actual ? ACTUAL_FRESH_MS : COPY_SNAPSHOT_INTERVAL_MS;
    const to = strategy.stoppedAt ?? new Date();
    const duration = window === "1d" ? 86_400_000 : window === "7d" ? 7 * 86_400_000 : window === "30d" ? 30 * 86_400_000 : to.getTime() - strategy.createdAt.getTime();
    const from = new Date(Math.max(strategy.createdAt.getTime(), to.getTime() - duration));
    // Bound history independently of strategy age; retain missing marks and gaps.
    const bucketMs = Math.max(60_000, Math.ceil((to.getTime() - from.getTime()) / 1000 / 60_000) * 60_000);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const baselineTime = new Date(Math.max(today.getTime(), strategy.createdAt.getTime()));
    const { sampled, first, last, windowFirst, maxGap, baseline } = await this.repository.runtime.performance(strategyId, from, to, baselineTime, bucketMs, freshMs);
    const points = sampled.map((r) => ({
      time: new Date(r.time as string | Date), equity: r.missing || r.equity === null ? null : wire(r.equity as string),
      totalPnl: r.missing || r.total_pnl === null ? null : wire(r.total_pnl as string),
      netDeposits: wire(r.net_deposits as string), exposureUsd: r.missing || r.exposure_usd === null ? null : wire(r.exposure_usd as string),
    }));
    const baselineValid = baseline && baselineTime.getTime() - baseline.time.getTime() <= freshMs;
    const fresh = last && to.getTime() - last.time.getTime() <= freshMs;
    const todayPnl = strategy.stoppedAt && strategy.stoppedAt.getTime() < today.getTime() ? 0 : baselineValid && fresh && baseline.totalPnl !== null && last.totalPnl !== null
      ? wire(Dec.from(last.totalPnl).sub(baseline.totalPnl)) : null;
    const complete = Boolean(first && windowFirst && fresh && windowFirst.time.getTime() <= from.getTime() + stepMs
      && maxGap <= freshMs && points.every((p) => p.equity !== null));
    return { strategyId, mode: actual ? "actual" : "paper", ...(actual ? { network: strategy.network } : {}), window, from, to, points, todayPnl,
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
