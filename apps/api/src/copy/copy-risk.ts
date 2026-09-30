/**
 * Pre-trade risk for one copy order (review §6): platform hard caps ∩ the
 * user's layer ∩ the strategy's own limits. Pure; the caller gathers the
 * state inside the transaction that also creates the order and its
 * reservation, so the numbers can't move between check and reserve.
 */
import { coinDex, coinKey, type CopyRiskLimits, type CopyStrategySettings } from "@trading-dashboard/shared/contracts";

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
  /** Requested notional, USDC. */
  notional: number;
  /** Mid or mark now. */
  px: number;
  /** Price the signal traded at (leader fill px); null for adoption. */
  signalPx: number | null;
  signalAgeSeconds: number;
  /** Coin's exchange max leverage, when known. */
  coinMaxLeverage: number | null;
  strategy: {
    allocated: number;
    equity: number;
    /** Σ|notional| of the strategy's positions at `px`. */
    exposure: number;
    /** Margin already held by approved, unfilled orders. */
    reservedMargin: number;
    /** Notional already held by approved, unfilled orders. */
    reservedNotional: number;
    ordersLastMinute: number;
  };
  user: {
    /** This coin, all of the user's strategies (incl. reserved), absolute notional. */
    coinExposure: number;
    /** All coins, all strategies (incl. reserved). */
    exposure: number;
  };
}

export type RiskDecision =
  | { ok: true; notional: number; margin: number; leverage: number; notes: string[] }
  | { ok: false; reason: string };

/** Effective leverage cap: the strategy's own (CopyDog max_leverage), the
 * platform's, and the exchange's for this coin, whichever is lowest. */
export function effectiveLeverage(limits: CopyRiskLimits, settings: CopyStrategySettings, coinMaxLeverage: number | null): number {
  return Math.max(1, Math.min(limits.maxLeverage, settings.maxLeverage ?? Infinity, coinMaxLeverage ?? Infinity));
}

/** Strategy exposure cap: CopyDog's max_total_exposure (null shows as allocation × 5 there). */
export function strategyExposureCap(settings: CopyStrategySettings, allocated: number): number {
  return settings.maxTotalExposureUsd ?? allocated * 5;
}

/** HIP-3 builder-dex market: the same parse as fills and positions use. */
export function isHip3(coin: string): boolean {
  return coinDex(coin) !== "";
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
    return { ok: true, notional: input.notional, margin: 0, leverage, notes: [] };
  }

  // Stop state, widest scope first.
  if (controls.platform.pauseNewRisk) return { ok: false, reason: "platform_paused" };
  if (controls.platform.reduceOnly) return { ok: false, reason: "platform_reduce_only" };
  if (controls.user.pauseNewRisk) return { ok: false, reason: "user_paused" };
  if (controls.user.reduceOnly) return { ok: false, reason: "user_reduce_only" };
  if (controls.strategy.pauseNewRisk) return { ok: false, reason: "strategy_paused" };
  if (controls.strategy.reduceOnly) return { ok: false, reason: "strategy_reduce_only" };

  // Symbol / dex.
  if (isHip3(input.coin) && !limits.allowHip3) return { ok: false, reason: "symbol_not_allowed" };
  if (limits.blockedCoins.some((c) => coinKey(c) === coinKey(input.coin))) return { ok: false, reason: "symbol_blocked" };

  // Signal quality.
  if (input.signalAgeSeconds > limits.maxSignalAgeSeconds) return { ok: false, reason: "stale_signal" };
  if (!(input.px > 0)) return { ok: false, reason: "no_price" };
  if (input.signalPx !== null && input.signalPx > 0) {
    const movedBps = (Math.abs(input.px - input.signalPx) / input.signalPx) * 10_000;
    if (movedBps > limits.maxSlippageBps) return { ok: false, reason: "price_moved" };
  }
  if (input.strategy.ordersLastMinute >= limits.maxOrdersPerMinute) return { ok: false, reason: "frequency" };
  if (!(input.notional > 0)) return { ok: false, reason: "zero_size" };

  const notes: string[] = [];
  let notional = input.notional;
  const clamp = (cap: number, note: string) => {
    const room = Math.max(0, cap);
    if (notional > room) {
      notional = room;
      notes.push(note);
    }
  };
  clamp(limits.maxOrderNotionalUsd, "max_order");
  clamp(limits.maxCoinExposureUsd - input.user.coinExposure, "max_coin_exposure");
  clamp(limits.maxUserExposureUsd - input.user.exposure, "max_user_exposure");
  const strategyCap = Math.min(strategyExposureCap(settings, input.strategy.allocated), Math.max(0, input.strategy.equity) * leverage);
  clamp(strategyCap - input.strategy.exposure - input.strategy.reservedNotional, "max_strategy_exposure");
  // Available funds: equity not already used as margin by positions or held for orders.
  const usedMargin = input.strategy.exposure / leverage + input.strategy.reservedMargin;
  const available = input.strategy.equity - usedMargin;
  clamp(available * leverage, "available_funds");

  if (notional < limits.minOrderNotionalUsd || notional <= 0) {
    return { ok: false, reason: notes.length ? `below_min_after_${notes[notes.length - 1]}` : "below_min_notional" };
  }
  return { ok: true, notional, margin: notional / leverage, leverage, notes };
}
