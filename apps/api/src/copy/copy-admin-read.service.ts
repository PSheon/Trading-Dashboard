import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  AdminCopyExposureResponse,
  AdminCopyOrdersResponse,
  AdminCopyOverview,
  AdminCopyStrategiesResponse,
  AdminCopyStrategyDetail,
  CopyOrderStatus,
  CopyStrategySettings,
  CopyStrategyStatus,
} from "@trading-dashboard/shared/contracts";

import { AppConfig } from "../config/app-config.js";
import { STUCK_ORDER_ATTEMPTS } from "./copy-execution.service.js";
import { CopyMarketService } from "./copy-market.service.js";
import { toCopyOrder, toCopyStrategy } from "./copy.mappers.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopyRepository } from "./copy.repository.js";

/**
 * Read models for the copy admin pages (AdminCopyController is built on this
 * service; every method needs `copy.read` at the route). Database reads plus
 * at most one allMids (weight 2, shared 3 s cache) to value positions.
 */
@Injectable()
export class CopyAdminReadService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: CopyRepository,
    private readonly market: CopyMarketService,
    private readonly policies: CopyRiskPolicyService,
  ) {}

  /** Platform stop state, counts, outbox health, last 24 h of orders and recent commands. */
  async overview(): Promise<AdminCopyOverview> {
    const [controls, byStatus, orders, outbox, checkpoint, policy, events, stuck] = await Promise.all([
      this.repository.readControls(0),
      this.repository.strategiesByStatus(),
      this.repository.ordersByStatusSince(new Date(Date.now() - 86_400_000)),
      this.repository.outboxStats(),
      this.repository.checkpoint(),
      this.policies.current(),
      this.repository.recentControlEvents(30),
      this.repository.stuckOrders(STUCK_ORDER_ATTEMPTS),
    ]);
    const pending = outbox.find((r) => r.status === "pending");
    const failed = outbox.find((r) => r.status === "failed");
    return {
      mode: this.config.value.copy.mode,
      platform: {
        pauseNewRisk: controls.platform?.pauseNewRisk ?? false,
        reduceOnly: controls.platform?.reduceOnly ?? false,
        revision: controls.platform?.revision ?? 0,
        updatedAt: controls.platform?.updatedAt ?? null,
      },
      strategies: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])) as Partial<Record<CopyStrategyStatus, number>> as Record<CopyStrategyStatus, number>,
      orders24h: Object.fromEntries(orders.map((r) => [r.status, Number(r.n)])) as Partial<Record<CopyOrderStatus, number>> as Record<CopyOrderStatus, number>,
      outbox: {
        pending: Number(pending?.n ?? 0),
        failed: Number(failed?.n ?? 0),
        checkpoint: String(checkpoint?.lastOutboxId ?? 0n),
        oldestPendingAt: pending?.oldest ? new Date(pending.oldest) : null,
      },
      riskPolicyVersion: policy.version,
      events: events.map(({ event, actorEmail }) => ({
        id: String(event.id), scope: event.scope, scopeId: event.scopeId, command: event.command, revision: event.revision,
        actorUserId: event.actorUserId, actorEmail, reason: event.reason,
        result: { cancelledOrders: Number(event.result.cancelledOrders ?? 0), closeOrders: Number(event.result.closeOrders ?? 0) },
        createdAt: event.createdAt,
      })),
      stuckOrders: stuck.map((o) => ({
        id: String(o.id), strategyId: o.strategyId, userId: o.userId, coin: o.coin, leg: o.leg, reduceOnly: o.reduceOnly,
        attempts: o.attempts, lastError: o.lastError, since: o.createdAt,
      })),
    };
  }

  async strategies(filter: { status?: CopyStrategyStatus; userId?: number; limit?: number } = {}): Promise<AdminCopyStrategiesResponse> {
    const rows = await this.repository.allStrategies({ ...filter, limit: Math.min(filter.limit ?? 200, 500) });
    const ids = rows.map((r) => r.strategy.id);
    const [positions, counts] = await Promise.all([this.repository.positionsOf(ids), this.repository.orderCounts(ids)]);
    const mids = positions.length ? await this.market.midPrices(positions.map((p) => p.coin)) : null;
    return {
      items: rows.map((r) => ({
        ...toCopyStrategy(r.strategy, r.settings as CopyStrategySettings, positions, mids, counts.get(r.strategy.id)),
        userId: r.strategy.userId,
        userEmail: r.userEmail,
      })),
    };
  }

  async strategy(id: number): Promise<AdminCopyStrategyDetail> {
    const row = await this.repository.strategyWithSettings(id);
    if (!row) throw new NotFoundException("Copy not found");
    const [positions, counts, versions, orders, ledger] = await Promise.all([
      this.repository.positionsOf([id]),
      this.repository.orderCounts([id]),
      this.repository.versionsOf(id),
      this.repository.ordersOfStrategy(id, 200),
      this.repository.ledgerOf(id, 200),
    ]);
    const mids = positions.length ? await this.market.midPrices(positions.map((p) => p.coin)) : null;
    return {
      strategy: { ...toCopyStrategy(row.strategy, row.settings as CopyStrategySettings, positions, mids, counts.get(id)), userId: row.strategy.userId, userEmail: row.userEmail },
      versions: versions.map((v) => ({ version: v.version, settings: v.settings as CopyStrategySettings, createdAt: v.createdAt })),
      orders: orders.map(toCopyOrder),
      ledger: ledger.map((l) => ({ id: String(l.id), kind: l.kind, amount: Number(l.amount), coin: l.coin, orderId: l.orderId === null ? null : String(l.orderId), createdAt: l.createdAt })),
    };
  }

  /** Paper orders, newest first; `status: ["rejected","cancelled"]` lists failures with their reasons. */
  async orders(filter: { status?: CopyOrderStatus[]; userId?: number; strategyId?: number; limit?: number } = {}): Promise<AdminCopyOrdersResponse> {
    const rows = await this.repository.allOrders({ ...filter, limit: Math.min(filter.limit ?? 200, 500) });
    return { items: rows.map((r) => ({ ...toCopyOrder(r.order), userEmail: r.userEmail })) };
  }

  /** Per-user exposure across live strategies, by coin, with the user's stop state. */
  async exposure(): Promise<AdminCopyExposureResponse> {
    const [rows, controls] = await Promise.all([this.repository.liveStrategies(), this.repository.userControls()]);
    const ids = rows.map((r) => r.strategy.id);
    const positions = await this.repository.positionsOf(ids);
    const mids = positions.length ? await this.market.midPrices(positions.map((p) => p.coin)) : null;
    const byUser = new Map<number, AdminCopyExposureResponse["items"][number]>();
    for (const { strategy, userEmail } of rows) {
      const control = controls.find((c) => c.scopeId === strategy.userId);
      const item = byUser.get(strategy.userId) ?? {
        userId: strategy.userId, userEmail, strategies: 0, allocated: 0, equity: 0 as number | null, exposureUsd: 0 as number | null, coins: [],
        control: { pauseNewRisk: control?.pauseNewRisk ?? false, reduceOnly: control?.reduceOnly ?? false, revision: control?.revision ?? 0 },
      };
      item.strategies += 1;
      item.allocated += Number(strategy.allocated);
      let equity: number | null = Number(strategy.cash);
      for (const p of positions.filter((x) => x.strategyId === strategy.id)) {
        const px = mids?.px.get(p.coin);
        const size = Number(p.size);
        if (px === undefined) { equity = null; item.exposureUsd = null; continue; }
        if (equity !== null) equity += size * (px - Number(p.entryPx));
        const n = Math.abs(size) * px;
        if (item.exposureUsd !== null) item.exposureUsd += n;
        let coin = item.coins.find((c) => c.coin === p.coin);
        if (!coin) item.coins.push((coin = { coin: p.coin, longUsd: 0, shortUsd: 0, netUsd: 0 }));
        if (size > 0) coin.longUsd += n; else coin.shortUsd += n;
        coin.netUsd = coin.longUsd - coin.shortUsd;
      }
      item.equity = item.equity === null || equity === null ? null : item.equity + equity;
      byUser.set(strategy.userId, item);
    }
    return { items: [...byUser.values()].sort((a, b) => (b.exposureUsd ?? 0) - (a.exposureUsd ?? 0)), pricedAt: mids?.at ?? null };
  }
}
