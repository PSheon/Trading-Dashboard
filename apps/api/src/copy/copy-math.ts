/**
 * Pure copy-trading math (no I/O): canonical legs of a verified leader
 * fill, follower sizing, exchange rounding and the paper ledger.
 *
 * Every price, size, notional, fee and balance is a {@link Dec} (an exact
 * decimal; review finding 9), from Hyperliquid's strings and Postgres
 * `numeric` through to what is written back. Nothing here is a binary
 * float. A value is rounded only where a rule says so, once:
 * - a size is cut down to the asset's lot (`floorSize`);
 * - a price follows Hyperliquid's tick rule (`roundPx`);
 * - a USDC amount (fee, realized PnL, funding, margin) is quantized to
 *   {@link USD_DP} decimals when it is computed, and that same value is
 *   what is added to the balance and written to the ledger, so the two
 *   always agree to the last digit;
 * - an averaged entry price keeps {@link PX_DP} decimals.
 */
import { createHash } from "node:crypto";

import type { CopyDirection, CopySizingMode } from "@trading-dashboard/shared/contracts";

import { Dec, PX_DP, USD_DP, type DecInput } from "../common/decimal/dec.js";

/** A verified leader fill, as stored in `fills.raw`. */
export interface LeaderFill {
  tid: bigint;
  coin: string;
  px: Dec;
  sz: Dec;
  side: "B" | "A";
  time: number;
  /** Signed leader position right before this fill; null when Hyperliquid didn't send it. */
  startPosition: Dec | null;
  /** The leader trade this fill is a part of; see {@link tradeKeyOf}. */
  tradeKey: string;
}

/**
 * The leader trade a fill belongs to: every slice of one TWAP shares
 * `twap:<id>`, every partial fill of one order shares `oid:<order id>`.
 * This is the unit of fixed sizing ("amount per trade"): a strategy spends
 * its per-trade amount once per key, however many fills the trade arrives
 * in and however the consumer happens to batch them.
 */
export function tradeKeyOf(fill: { oid: number; twapId?: number | null }): string {
  return fill.twapId !== undefined && fill.twapId !== null ? `twap:${fill.twapId}` : `oid:${fill.oid}`;
}

/**
 * One canonical leg of a leader fill.
 * - `open`: the leader's position grew by `size` on side `sign` (+1 long, −1 short).
 * - `close`: the leader's `sign` position shrank by `fraction` of what it was (0 < fraction ≤ 1).
 * A flip (long → short or back) is two legs: a full close of the old side and an open of the new.
 */
export type SignalLeg =
  | { tid: bigint; coin: string; time: number; px: Dec; tradeKey: string; leg: "open"; sign: 1 | -1; size: Dec }
  | { tid: bigint; coin: string; time: number; px: Dec; tradeKey: string; leg: "close"; sign: 1 | -1; size: Dec; fraction: Dec };

/** The legs of one fill, from its own startPosition, so fills can be
 * processed in any order. Null when the fill has no startPosition (it can't
 * be classified without guessing). */
export function legsOf(fill: LeaderFill): SignalLeg[] | null {
  if (fill.startPosition === null) return null;
  const start = fill.startPosition;
  const delta = fill.side === "B" ? fill.sz : fill.sz.neg();
  const end = start.add(delta);
  const s0 = start.sign;
  const s1 = end.sign;
  const base = { tid: fill.tid, coin: fill.coin, time: fill.time, px: fill.px, tradeKey: fill.tradeKey };
  if (!fill.sz.isPositive) return [];
  if (s0 === 0) return [{ ...base, leg: "open", sign: delta.sign as 1 | -1, size: fill.sz }];
  if (s1 === s0) {
    if (end.abs().gt(start.abs())) return [{ ...base, leg: "open", sign: s0, size: fill.sz }];
    return [{ ...base, leg: "close", sign: s0, size: fill.sz, fraction: Dec.min(Dec.ONE, fill.sz.div(start.abs())) }];
  }
  const close: SignalLeg = { ...base, leg: "close", sign: s0, size: start.abs(), fraction: Dec.ONE };
  if (s1 === 0) return [close];
  return [close, { ...base, leg: "open", sign: s1, size: end.abs() }];
}

/** Follower side for a leader side: reverse copies trade the opposite way. */
export function followerSign(leaderSign: 1 | -1, direction: CopyDirection): 1 | -1 {
  return direction === "same" ? leaderSign : (-leaderSign as 1 | -1);
}

/**
 * Follower notional for a copied open (review §5).
 * - ratio: the leader's fill notional × (strategy equity ÷ leader account
 *   value), CopyDog's "if they use 5% of their balance, you use 5% of
 *   yours". An unknown or non-positive leader account value yields null:
 *   partial leader data is never treated as 0.
 * - fixed: the strategy's per-trade USDC notional.
 */
export function openNotional(args: {
  mode: CopySizingMode;
  perTradeUsd: number | null;
  leaderNotional: Dec;
  strategyEquity: Dec;
  leaderEquity: Dec | null;
}): Dec | null {
  if (args.mode === "fixed") return args.perTradeUsd && args.perTradeUsd > 0 ? Dec.from(args.perTradeUsd) : null;
  if (args.leaderEquity === null || !args.leaderEquity.isPositive || !args.strategyEquity.isPositive) return null;
  return args.leaderNotional.mul(args.strategyEquity).div(args.leaderEquity);
}

/** The fraction at or above which a reduction is a full close. Hyperliquid
 * sizes have at most 8 decimals, so a leader's own full close is exactly 1;
 * this only absorbs the 18th decimal of a product of fractions. */
const FULL = Dec.from("0.999999999999");

/** Size to reduce when the leader closes `fraction` of their position:
 * the same fraction of the follower's own strategy position (never more). */
export function reduceSize(followerAbsSize: Dec, fraction: Dec): Dec {
  if (!followerAbsSize.isPositive || !fraction.isPositive) return Dec.ZERO;
  return fraction.gte(FULL) ? followerAbsSize : followerAbsSize.mul(fraction);
}

/**
 * A proportional reduction that keeps what rounding would lose (review 42).
 * `carry` is the size earlier reductions called for that was below one lot
 * and so was not traded: the follower's position is that much larger than
 * the leader's fractions say. This reduction is owed the carry plus
 * `fraction` of the rest; `size` is what one order can do (whole lots) and
 * the remainder becomes the new carry. A full close takes everything.
 * Without `szDecimals` (the universe could not be read) nothing is rounded.
 */
export function reduceWithCarry(followerAbsSize: Dec, fraction: Dec, carry: Dec, szDecimals: number | null): { size: Dec; carry: Dec } {
  if (!followerAbsSize.isPositive || !fraction.isPositive) return { size: Dec.ZERO, carry: Dec.max(Dec.ZERO, Dec.min(carry, followerAbsSize)) };
  if (fraction.gte(FULL)) return { size: followerAbsSize, carry: Dec.ZERO };
  const owed = Dec.min(followerAbsSize, Dec.max(Dec.ZERO, carry));
  const want = Dec.min(followerAbsSize, owed.add(followerAbsSize.sub(owed).mul(fraction)));
  const size = szDecimals === null ? want : floorSize(want, szDecimals);
  return { size, carry: want.sub(size) };
}

/** Round a size down to the asset's `szDecimals` (Hyperliquid rejects more). */
export function floorSize(size: Dec, szDecimals: number): Dec {
  return size.isPositive ? size.floor(szDecimals) : Dec.ZERO;
}

/** Hyperliquid perp prices: at most 5 significant figures and at most
 * 6 − szDecimals decimals (integers always allowed). */
export function roundPx(px: Dec, szDecimals: number): Dec {
  if (!px.isPositive || px.isInteger) return px;
  return px.toSignificant(5).round(Math.max(0, 6 - szDecimals));
}

/** A plain decimal string for a numeric column: rounded to `digits`
 * decimals (8 by default), no exponent, no trailing zeros, no "-0". */
export function dec(value: DecInput, digits = USD_DP): string {
  return Dec.from(value).round(digits).toString();
}

/** A USDC amount at the scale it is stored and summed at. */
export function usd(value: Dec): Dec {
  return value.round(USD_DP);
}

/** The simulated execution price: `basePx` moved against the taker by `slippageBps`. */
export function slippedPx(basePx: Dec, side: "B" | "A", slippageBps: DecInput): Dec {
  const k = Dec.from(slippageBps).div(10_000);
  return side === "B" ? basePx.mul(Dec.ONE.add(k)) : basePx.mul(Dec.ONE.sub(k));
}

/** A position after one fill. `sign` +1 buys, −1 sells; the fill never
 * crosses zero (flips arrive as a reduce-only close then an open). The
 * entry price keeps {@link PX_DP} decimals and the realized PnL is a USDC
 * amount ({@link USD_DP}). */
export function applyFill(pos: { size: Dec; entryPx: Dec }, sign: 1 | -1, size: Dec, px: Dec): { size: Dec; entryPx: Dec; realizedPnl: Dec } {
  const delta = sign > 0 ? size : size.neg();
  const current = pos.size;
  if (current.sign === 0 || current.sign === delta.sign) {
    const total = current.abs().add(size);
    const entryPx = total.isPositive ? current.abs().mul(pos.entryPx).add(size.mul(px)).div(total).round(PX_DP) : px;
    return { size: current.add(delta), entryPx, realizedPnl: Dec.ZERO };
  }
  const closed = Dec.min(size, current.abs());
  const realizedPnl = usd(closed.mul(px.sub(pos.entryPx)).mul(current.sign));
  const next = current.add(delta.sign > 0 ? closed : closed.neg());
  return { size: next, entryPx: next.isZero ? Dec.ZERO : pos.entryPx, realizedPnl };
}

/** Taker and builder fees of a fill, in USDC ({@link USD_DP}). `builderFeeTenthsBps`
 * is the admin's revenue.builderFeeTenthsBps (1 = 0.001%). */
export function fillFees(notional: Dec, takerFeeBps: DecInput, builderFeeTenthsBps: DecInput): { fee: Dec; builderFee: Dec } {
  return { fee: usd(notional.mul(takerFeeBps).div(10_000)), builderFee: usd(notional.mul(builderFeeTenthsBps).div(100_000)) };
}

/** Funding a position pays for `hours` hours (positive = paid, negative =
 * received), in USDC ({@link USD_DP}): longs pay shorts when the rate is
 * positive, as on Hyperliquid. */
export function fundingPayment(size: Dec, px: Dec, hourlyRate: Dec, hours = 1): Dec {
  return usd(size.mul(px).mul(hourlyRate).mul(hours));
}

/** The price of a leader's position now: its value ÷ its size (the mark
 * Hyperliquid valued it at), or its entry price when the value is missing. */
export function leaderPositionPx(position: { szi: string; positionValue?: string; entryPx?: string | null }): Dec {
  const size = Dec.from(position.szi).abs();
  const value = Dec.parse(position.positionValue);
  if (value?.isPositive && size.isPositive) return value.div(size);
  return Dec.parse(position.entryPx) ?? Dec.ZERO;
}

const HOUR_MS = 3_600_000;
/**
 * Hourly funding payments a position owes at `hour` (a whole hour): one for
 * every hour boundary after `fundingThrough` up to and including `hour`.
 * A position opened at 10:30 pays at 11:00 (review 38: counting whole
 * elapsed hours skipped that first boundary of every holding period).
 */
export function fundingHours(fundingThrough: Date, hour: Date): number {
  return Math.max(0, Math.floor(hour.getTime() / HOUR_MS) - Math.floor(fundingThrough.getTime() / HOUR_MS));
}

/** Deterministic client order id from the dedupe key (Hyperliquid's cloid
 * is 16 bytes hex): a retried order keeps its id, so testnet/live can look
 * it up instead of sending it twice. */
export function cloidOf(key: string): string {
  return "0x" + createHash("sha256").update(key).digest("hex").slice(0, 32);
}
