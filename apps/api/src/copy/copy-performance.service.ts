import { Injectable, NotFoundException } from "@nestjs/common";
import { copyEventsQuerySchema, copyPerformanceQuerySchema, type CopyEventsResponse, type CopyPerformanceResponse } from "@trading-dashboard/shared/contracts";
import { Dec } from "../common/decimal/dec.js";
import { parseOr400 } from "../common/http/validation.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { CopyMarketService, MIDS_TTL_MS } from "./copy-market.service.js";
import { wire } from "./copy.mappers.js";
import { strategyValue } from "./copy-planner.service.js";
import { CopyRepository } from "./copy.repository.js";

export const COPY_SNAPSHOT_INTERVAL_MS = 60_000;
const FRESH_MS = 2 * COPY_SNAPSHOT_INTERVAL_MS;

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
