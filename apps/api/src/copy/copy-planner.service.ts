import { Injectable } from "@nestjs/common";
import type { CopyLeg, CopyRiskLimits, CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import type { DbTransaction } from "../db/unit-of-work.js";
import type { AssetInfo, Mids } from "./copy-market.service.js";
import { cloidOf, dec, floorSize } from "./copy-math.js";
import { evaluateRisk, isHip3 } from "./copy-risk.js";
import { CopyRepository, type ControlRow, type OrderRow, type PositionRow, type StrategyRow } from "./copy.repository.js";

export interface PolicyInForce {
  version: number;
  limits: CopyRiskLimits;
  /** The stored policy is unreadable: new risk is refused. */
  invalid?: boolean;
}

export interface Controls {
  platform: ControlRow | undefined;
  user: ControlRow | undefined;
}

/** Everything one order decision needs, gathered by the caller inside its transaction. */
export interface PlaceOrder {
  strategy: StrategyRow;
  settings: CopyStrategySettings;
  policy: PolicyInForce;
  controls: Controls;
  mids: Mids | null;
  assets: Map<string, AssetInfo> | null;
  coin: string;
  leg: CopyLeg;
  side: "B" | "A";
  /** Risk-increasing orders: the requested USDC notional. */
  notional?: number;
  /** Reduce-only orders: the coin size to reduce. */
  size?: number;
  signalPx: number;
  signalTime: Date;
  signalTids: bigint[];
  /** Makes the client order id; unique per order. */
  dedupeKey: string;
  /** A pre-risk refusal (e.g. unknown leader equity): recorded as a rejected order. */
  rejectReason?: string;
}

/** A strategy's value at current mids: equity is null when an open position has no price. */
export function strategyValue(strategy: StrategyRow, positions: PositionRow[], mids: Mids | null) {
  let unrealized = 0;
  let exposure = 0;
  let priced = true;
  for (const p of positions) {
    const size = Number(p.size);
    if (size === 0) continue;
    const px = mids?.px.get(p.coin);
    if (px === undefined) {
      priced = false;
      continue;
    }
    unrealized += size * (px - Number(p.entryPx));
    exposure += Math.abs(size) * px;
  }
  const cash = Number(strategy.cash);
  return priced ? { equity: cash + unrealized, unrealized, exposure } : { equity: null, unrealized: null, exposure: null };
}

/**
 * Turns one copy decision into an order row, with pre-trade risk and the
 * margin reservation in the caller's transaction (review §6). The caller
 * holds, in this order: the platform and user control rows FOR SHARE, then
 * the strategy row FOR UPDATE.
 */
@Injectable()
export class CopyOrderPlanner {
  constructor(private readonly repository: CopyRepository) {}

  async place(tx: DbTransaction, o: PlaceOrder): Promise<OrderRow | null> {
    const increasesRisk = !(o.leg === "close" || o.leg === "stop_close");
    const revisions = { platform: o.controls.platform?.revision ?? 0, user: o.controls.user?.revision ?? 0, strategy: o.strategy.controlRevision };
    const base = {
      cloid: cloidOf(o.dedupeKey),
      strategyId: o.strategy.id,
      userId: o.strategy.userId,
      strategyVersion: o.strategy.version,
      riskPolicyVersion: o.policy.version,
      leaderAddress: o.strategy.leaderAddress,
      coin: o.coin,
      leg: o.leg,
      side: o.side,
      reduceOnly: !increasesRisk,
      signalPx: dec(o.signalPx),
      signalTime: o.signalTime,
      signalTids: o.signalTids,
      controlRevisions: revisions,
    };
    const asset = o.assets?.get(o.coin);
    const px = o.mids?.px.get(o.coin) ?? null;

    if (!increasesRisk) {
      const size = asset ? floorSize(o.size ?? 0, asset.szDecimals) : (o.size ?? 0);
      if (!(size > 0)) return null;
      return this.repository.insertOrder(tx, { ...base, size: dec(size), status: "risk_approved" });
    }

    const reject = (reason: string, size = 0) => this.repository.insertOrder(tx, { ...base, size: dec(size), status: "rejected", reason });
    if (o.rejectReason) return reject(o.rejectReason);
    if (o.policy.invalid) return reject("risk_policy_invalid");
    if (o.strategy.status !== "active") return reject(`strategy_${o.strategy.status}`);
    if (!asset && !isHip3(o.coin)) return reject("no_asset_info");

    const [positions, reserved, userStrategyIds] = await Promise.all([
      this.repository.positionsOf([o.strategy.id], tx),
      this.repository.heldReservations([o.strategy.id], tx),
      this.repository.liveStrategyIdsOfUser(tx, o.strategy.userId),
    ]);
    const value = strategyValue(o.strategy, positions, o.mids);
    const userIds = userStrategyIds.map((s) => s.id);
    const [userPositions, userReserved] = await Promise.all([this.repository.positionsOf(userIds, tx), this.repository.heldReservations(userIds, tx)]);
    let userExposure = 0;
    let coinExposure = 0;
    let userPriced = true;
    for (const p of userPositions) {
      const ppx = o.mids?.px.get(p.coin);
      if (ppx === undefined) { userPriced = false; continue; }
      const n = Math.abs(Number(p.size)) * ppx;
      userExposure += n;
      if (p.coin === o.coin) coinExposure += n;
    }
    for (const r of userReserved) {
      userExposure += Number(r.notional);
      if (r.coin === o.coin) coinExposure += Number(r.notional);
    }
    if (px === null || value.equity === null || !userPriced) return reject("no_price");

    const decision = evaluateRisk({
      limits: o.policy.limits,
      settings: o.settings,
      controls: {
        platform: { pauseNewRisk: o.controls.platform?.pauseNewRisk ?? false, reduceOnly: o.controls.platform?.reduceOnly ?? false },
        user: { pauseNewRisk: o.controls.user?.pauseNewRisk ?? false, reduceOnly: o.controls.user?.reduceOnly ?? false },
        strategy: { pauseNewRisk: o.strategy.pauseNewRisk, reduceOnly: o.strategy.reduceOnly },
      },
      coin: o.coin,
      increasesRisk: true,
      notional: o.notional ?? 0,
      px,
      signalPx: o.leg === "adopt" ? null : o.signalPx,
      signalAgeSeconds: (Date.now() - o.signalTime.getTime()) / 1000,
      coinMaxLeverage: asset?.maxLeverage ?? null,
      strategy: {
        allocated: Number(o.strategy.allocated),
        equity: value.equity,
        exposure: value.exposure ?? 0,
        reservedMargin: reserved.reduce((a, r) => a + Number(r.margin), 0),
        reservedNotional: reserved.reduce((a, r) => a + Number(r.notional), 0),
        ordersLastMinute: await this.repository.ordersLastMinute(tx, o.strategy.id),
      },
      user: { coinExposure, exposure: userExposure },
    });
    if (!decision.ok) return reject(decision.reason, asset ? floorSize((o.notional ?? 0) / px, asset.szDecimals) : 0);

    const size = asset ? floorSize(decision.notional / px, asset.szDecimals) : decision.notional / px;
    const notional = size * px;
    if (!(size > 0) || notional < o.policy.limits.minOrderNotionalUsd) return reject("below_min_after_rounding", size);
    const order = await this.repository.insertOrder(tx, {
      ...base,
      size: dec(size),
      status: "risk_approved",
      reason: decision.notes.length ? `clamped:${decision.notes.join(",")}` : null,
    });
    await this.repository.insertReservation(tx, {
      orderId: order.id,
      strategyId: o.strategy.id,
      userId: o.strategy.userId,
      coin: o.coin,
      notional: dec(notional),
      margin: dec(notional / decision.leverage),
    });
    return order;
  }
}
