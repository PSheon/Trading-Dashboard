/**
 * Pre-trade risk for one copy order (review §6): platform hard caps ∩ the
 * user's layer ∩ the strategy's own limits. Pure; the caller gathers the
 * state inside the transaction that also creates the order and its
 * reservation, so the numbers can't move between check and reserve.
 */
import { coinDex, coinKey, type CopyRiskLimits, type CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { Dec } from "../common/decimal/dec.js";
import { usd } from "./copy-math.js";

export interface ControlFlags {
  pauseNewRisk: boolean;
  reduceOnly: boolean;
}

export interface RiskInput {
  limits: CopyRiskLimits;
  settings: CopyStrategySettings;
  controls: { platform: ControlFlags; user: ControlFlags; strategy: ControlFlags };
  coin: string;
  /** Risk-increasing (open / adopt) or reduce-only (close / stop_close). */
  increasesRisk: boolean;
  /** An adoption leg (the leader's position at the start of a copy, or its
   * repair): not a reaction to a fill, so the signal-age and per-minute
   * rules don't apply (review 39). Every cap still does. */
  adoption?: boolean;
  /** Requested notional, USDC. */
  notional: Dec;
  /** Mid or mark now. */
  px: Dec;
  /** Price the signal traded at (leader fill px); null for adoption. */
  signalPx: Dec | null;
  signalAgeSeconds: number;
  /** Coin's exchange max leverage, when known. */
  coinMaxLeverage: number | null;
  strategy: {
    allocated: Dec;
    equity: Dec;
    /** Σ|notional| of the strategy's positions at `px`. */
    exposure: Dec;
    /** Margin already held by approved, unfilled orders. */
    reservedMargin: Dec;
    /** Notional already held by approved, unfilled orders. */
    reservedNotional: Dec;
    ordersLastMinute: number;
  };
  user: {
    /** This coin, all of the user's strategies (incl. reserved), absolute notional. */
    coinExposure: Dec;
    /** All coins, all strategies (incl. reserved). */
    exposure: Dec;
  };
}

export type RiskDecision =
  | { ok: true; notional: Dec; margin: Dec; leverage: number; notes: string[] }
  | { ok: false; reason: string };

/** Effective leverage cap: the strategy's own (CopyDog max_leverage), the
 * platform's, and the exchange's for this coin, whichever is lowest. */
export function effectiveLeverage(limits: CopyRiskLimits, settings: CopyStrategySettings, coinMaxLeverage: number | null): number {
  return Math.max(1, Math.min(limits.maxLeverage, settings.maxLeverage ?? Infinity, coinMaxLeverage ?? Infinity));
}

/** Strategy exposure cap: CopyDog's max_total_exposure (null shows as allocation × 5 there). */
export function strategyExposureCap(settings: CopyStrategySettings, allocated: Dec): Dec {
  return settings.maxTotalExposureUsd === null ? allocated.mul(5) : Dec.from(settings.maxTotalExposureUsd);
}

/** HIP-3 builder-dex market: the same parse as fills and positions use. */
export function isHip3(coin: string): boolean {
  return coinDex(coin) !== "";
}

/** Why the policy never lets `coin` take new risk, whatever the market
 * data says: a HIP-3 market while `allowHip3` is off, or a blocked coin.
 * Decided before any price is needed. */
export function symbolRefusal(limits: CopyRiskLimits, coin: string): "symbol_not_allowed" | "symbol_blocked" | null {
  if (isHip3(coin) && !limits.allowHip3) return "symbol_not_allowed";
  if (limits.blockedCoins.some((c) => coinKey(c) === coinKey(coin))) return "symbol_blocked";
  return null;
}

/** The coins of `coins` whose market data is worth reading: everything on
 * the main dex, and HIP-3 markets only while the policy allows them (each
 * builder dex costs its own requests). */
export function pricedCoins(limits: CopyRiskLimits, coins: Iterable<string>): string[] {
  return [...new Set(coins)].filter((coin) => !isHip3(coin) || limits.allowHip3);
}

/**
 * Decide one order. Reductions are only refused by the kill of the whole
 * copy (never by caps, age, price or frequency): refusing to reduce would
 * leave the follower more exposed than the leader. Risk-increasing orders
 * are clamped to every remaining cap and refused when what is left is
 * under the minimum order.
 */
export function evaluateRisk(input: RiskInput): RiskDecision {
  const { limits, settings, controls } = input;
  const leverage = effectiveLeverage(limits, settings, input.coinMaxLeverage);
  if (!input.increasesRisk) {
    return { ok: true, notional: input.notional, margin: Dec.ZERO, leverage, notes: [] };
  }

  // Stop state, widest scope first.
  if (controls.platform.pauseNewRisk) return { ok: false, reason: "platform_paused" };
  if (controls.platform.reduceOnly) return { ok: false, reason: "platform_reduce_only" };
  if (controls.user.pauseNewRisk) return { ok: false, reason: "user_paused" };
  if (controls.user.reduceOnly) return { ok: false, reason: "user_reduce_only" };
  if (controls.strategy.pauseNewRisk) return { ok: false, reason: "strategy_paused" };
  if (controls.strategy.reduceOnly) return { ok: false, reason: "strategy_reduce_only" };

  // Symbol / dex.
  const refused = symbolRefusal(limits, input.coin);
  if (refused) return { ok: false, reason: refused };

  // Signal quality.
  if (!input.adoption && input.signalAgeSeconds > limits.maxSignalAgeSeconds) return { ok: false, reason: "stale_signal" };
  if (!input.px.isPositive) return { ok: false, reason: "no_price" };
  if (input.signalPx !== null && input.signalPx.isPositive) {
    const movedBps = input.px.sub(input.signalPx).abs().div(input.signalPx).mul(10_000);
    if (movedBps.gt(limits.maxSlippageBps)) return { ok: false, reason: "price_moved" };
  }
  if (!input.adoption && input.strategy.ordersLastMinute >= limits.maxOrdersPerMinute) return { ok: false, reason: "frequency" };
  if (!input.notional.isPositive) return { ok: false, reason: "zero_size" };

  const notes: string[] = [];
  let notional = input.notional;
  const clamp = (cap: Dec, note: string) => {
    const room = Dec.max(Dec.ZERO, cap);
    if (notional.gt(room)) {
      notional = room;
      notes.push(note);
    }
  };
  clamp(Dec.from(limits.maxOrderNotionalUsd), "max_order");
  clamp(Dec.from(limits.maxCoinExposureUsd).sub(input.user.coinExposure), "max_coin_exposure");
  clamp(Dec.from(limits.maxUserExposureUsd).sub(input.user.exposure), "max_user_exposure");
  const strategyCap = Dec.min(strategyExposureCap(settings, input.strategy.allocated), Dec.max(Dec.ZERO, input.strategy.equity).mul(leverage));
  clamp(strategyCap.sub(input.strategy.exposure).sub(input.strategy.reservedNotional), "max_strategy_exposure");
  // Available funds: equity not already used as margin by positions or held for orders.
  const usedMargin = input.strategy.exposure.div(leverage).add(input.strategy.reservedMargin);
  const available = input.strategy.equity.sub(usedMargin);
  clamp(available.mul(leverage), "available_funds");

  if (notional.lt(limits.minOrderNotionalUsd) || !notional.isPositive) {
    return { ok: false, reason: notes.length ? `below_min_after_${notes[notes.length - 1]}` : "below_min_notional" };
  }
  return { ok: true, notional, margin: usd(notional.div(leverage)), leverage, notes };
}
