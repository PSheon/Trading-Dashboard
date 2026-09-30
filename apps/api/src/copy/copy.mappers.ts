import type { CopyOrder, CopyPosition, CopyStrategy, CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import type { Mids } from "./copy-market.service.js";
import type { OrderRow, PositionRow, StrategyRow } from "./copy.repository.js";

export function toCopyPosition(p: PositionRow, mids: Mids | null): CopyPosition {
  const size = Number(p.size);
  const entryPx = Number(p.entryPx);
  const markPx = mids?.px.get(p.coin) ?? null;
  return {
    coin: p.coin,
    size,
    entryPx,
    markPx,
    notionalUsd: markPx === null ? null : Math.abs(size) * markPx,
    unrealizedPnl: markPx === null ? null : size * (markPx - entryPx),
    realizedPnl: Number(p.realizedPnl),
    funding: Number(p.funding),
    openedAt: p.openedAt,
  };
}

/** A strategy for the wire. Values that need a price are null while a
 * position has none (never shown as 0). A stopped strategy is valued at
 * its final cash. */
export function toCopyStrategy(s: StrategyRow, settings: CopyStrategySettings, positions: PositionRow[], mids: Mids | null, counts?: { pending: number; filled: number }): CopyStrategy {
  const mapped = positions.filter((p) => p.strategyId === s.id && Number(p.size) !== 0).map((p) => toCopyPosition(p, mids));
  const priced = mapped.every((p) => p.unrealizedPnl !== null);
  const unrealized = priced ? mapped.reduce((a, p) => a + (p.unrealizedPnl ?? 0), 0) : null;
  const exposure = priced ? mapped.reduce((a, p) => a + (p.notionalUsd ?? 0), 0) : null;
  const cash = Number(s.cash);
  const allocated = Number(s.allocated);
  const equity = unrealized === null ? null : cash + unrealized;
  const totalPnl = equity === null ? null : equity - allocated;
  return {
    id: s.id,
    mode: "paper",
    leaderAddress: s.leaderAddress,
    status: s.status,
    version: s.version,
    settings,
    allocated,
    cash,
    equity,
    unrealizedPnl: unrealized,
    realizedPnl: Number(s.realizedPnl),
    fees: Number(s.fees),
    funding: Number(s.funding),
    totalPnl,
    roiPct: totalPnl === null || allocated <= 0 ? null : (totalPnl / allocated) * 100,
    exposureUsd: exposure,
    pauseNewRisk: s.pauseNewRisk,
    reduceOnly: s.reduceOnly,
    tradesCopied: counts?.filled ?? 0,
    pendingOrders: counts?.pending ?? 0,
    positions: mapped,
    activatedAt: s.activatedAt,
    createdAt: s.createdAt,
    stoppedAt: s.stoppedAt,
  };
}

export function toCopyOrder(o: OrderRow): CopyOrder {
  return {
    id: String(o.id),
    cloid: o.cloid,
    strategyId: o.strategyId,
    userId: o.userId,
    leaderAddress: o.leaderAddress,
    coin: o.coin,
    leg: o.leg,
    side: o.side,
    reduceOnly: o.reduceOnly,
    size: Number(o.size),
    signalPx: Number(o.signalPx),
    signalTime: o.signalTime,
    status: o.status,
    reason: o.reason,
    filledSize: Number(o.filledSize),
    avgPx: o.avgPx === null ? null : Number(o.avgPx),
    fee: Number(o.fee),
    builderFee: Number(o.builderFee),
    strategyVersion: o.strategyVersion,
    riskPolicyVersion: o.riskPolicyVersion,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
