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
import { Dec } from "../common/decimal/dec.js";
import { toCopyOrder, toCopyStrategy, wire } from "./copy.mappers.js";
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
      ledger: ledger.map((l) => ({ id: String(l.id), kind: l.kind, amount: wire(l.amount), coin: l.coin, orderId: l.orderId === null ? null : String(l.orderId), createdAt: l.createdAt })),
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
    // Summed as decimals per user; numbers only in the answer.
    interface Sums { userEmail: string | null; strategies: number; allocated: Dec; equity: Dec | null; exposure: Dec | null; coins: Map<string, { long: Dec; short: Dec }> }
    const sums = new Map<number, Sums>();
    for (const { strategy, userEmail } of rows) {
      const item = sums.get(strategy.userId) ?? { userEmail, strategies: 0, allocated: Dec.ZERO, equity: Dec.ZERO as Dec | null, exposure: Dec.ZERO as Dec | null, coins: new Map() };
      item.strategies += 1;
      item.allocated = item.allocated.add(strategy.allocated);
      let equity: Dec | null = Dec.from(strategy.cash);
      for (const p of positions.filter((x) => x.strategyId === strategy.id)) {
        const px = mids?.px.get(p.coin);
        const size = Dec.from(p.size);
        if (px === undefined) { equity = null; item.exposure = null; continue; }
        if (equity !== null) equity = equity.add(size.mul(px.sub(p.entryPx)));
        const n = size.abs().mul(px);
        if (item.exposure !== null) item.exposure = item.exposure.add(n);
        const coin = item.coins.get(p.coin) ?? { long: Dec.ZERO, short: Dec.ZERO };
        if (size.isPositive) coin.long = coin.long.add(n); else coin.short = coin.short.add(n);
        item.coins.set(p.coin, coin);
      }
      item.equity = item.equity === null || equity === null ? null : item.equity.add(equity);
      sums.set(strategy.userId, item);
    }
    const byUser = new Map<number, AdminCopyExposureResponse["items"][number]>();
    for (const [userId, item] of sums) {
      const control = controls.find((c) => c.scopeId === userId);
      byUser.set(userId, {
        userId, userEmail: item.userEmail, strategies: item.strategies, allocated: wire(item.allocated),
        equity: item.equity === null ? null : wire(item.equity), exposureUsd: item.exposure === null ? null : wire(item.exposure),
        coins: [...item.coins].map(([coin, c]) => ({ coin, longUsd: wire(c.long), shortUsd: wire(c.short), netUsd: wire(c.long.sub(c.short)) })),
        control: { pauseNewRisk: control?.pauseNewRisk ?? false, reduceOnly: control?.reduceOnly ?? false, revision: control?.revision ?? 0 },
      });
    }
    return { items: [...byUser.values()].sort((a, b) => (b.exposureUsd ?? 0) - (a.exposureUsd ?? 0)), pricedAt: mids?.at ?? null };
  }
}
