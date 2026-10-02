import type { CopyOrder, CopyPosition, CopyStrategy, CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { Dec, type DecInput } from "../common/decimal/dec.js";
import type { Mids } from "./copy-market.service.js";
import type { OrderRow, PositionRow, StrategyRow } from "./copy.repository.js";

/**
 * The JSON boundary: the wire contract carries money and sizes as JSON
 * numbers, for display. Everything is computed as a {@link Dec} first and
 * becomes a number here, in the last step, and nowhere else in the copy
 * engine. A value from the response is never fed back into the ledger.
 */
export const wire = (value: DecInput): number => Dec.from(value).toNumber();

export function toCopyPosition(p: PositionRow, mids: Mids | null): CopyPosition {
  const size = Dec.from(p.size);
  const entryPx = Dec.from(p.entryPx);
  const markPx = mids?.px.get(p.coin) ?? null;
  return {
    coin: p.coin,
    size: wire(size),
    entryPx: wire(entryPx),
    markPx: markPx === null ? null : wire(markPx),
    notionalUsd: markPx === null ? null : wire(size.abs().mul(markPx)),
    unrealizedPnl: markPx === null ? null : wire(size.mul(markPx.sub(entryPx))),
    realizedPnl: wire(p.realizedPnl),
    funding: wire(p.funding),
    openedAt: p.openedAt,
  };
}

/** A strategy for the wire. Values that need a price are null while a
 * position has none (never shown as 0). A stopped strategy is valued at
 * its final cash. */
export function toCopyStrategy(s: StrategyRow, settings: CopyStrategySettings, positions: PositionRow[], mids: Mids | null, counts?: { pending: number; filled: number }): CopyStrategy {
  const own = positions.filter((p) => p.strategyId === s.id && !Dec.from(p.size).isZero);
  const priced = own.every((p) => mids?.px.has(p.coin));
  const unrealized = priced ? Dec.sum(own.map((p) => Dec.from(p.size).mul(mids!.px.get(p.coin)!.sub(p.entryPx)))) : null;
  const exposure = priced ? Dec.sum(own.map((p) => Dec.from(p.size).abs().mul(mids!.px.get(p.coin)!))) : null;
  const cash = Dec.from(s.cash);
  const allocated = Dec.from(s.allocated);
  const equity = unrealized === null ? null : cash.add(unrealized);
  const totalPnl = equity === null ? null : equity.sub(allocated);
  return {
    id: s.id,
    mode: "paper",
    leaderAddress: s.leaderAddress,
    status: s.status,
    version: s.version,
    settings,
    allocated: wire(allocated),
    cash: wire(cash),
    equity: equity === null ? null : wire(equity),
    unrealizedPnl: unrealized === null ? null : wire(unrealized),
    realizedPnl: wire(s.realizedPnl),
    fees: wire(s.fees),
    funding: wire(s.funding),
    totalPnl: totalPnl === null ? null : wire(totalPnl),
    roiPct: totalPnl === null || !allocated.isPositive ? null : wire(totalPnl.div(allocated).mul(100)),
    exposureUsd: exposure === null ? null : wire(exposure),
    pauseNewRisk: s.pauseNewRisk,
    reduceOnly: s.reduceOnly,
    tradesCopied: counts?.filled ?? 0,
    pendingOrders: counts?.pending ?? 0,
    positions: own.map((p) => toCopyPosition(p, mids)),
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
    size: wire(o.size),
    signalPx: wire(o.signalPx),
    signalTime: o.signalTime,
    status: o.status,
    reason: o.reason,
    filledSize: wire(o.filledSize),
    avgPx: o.avgPx === null ? null : wire(o.avgPx),
    fee: wire(o.fee),
    builderFee: wire(o.builderFee),
    strategyVersion: o.strategyVersion,
    riskPolicyVersion: o.riskPolicyVersion,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
