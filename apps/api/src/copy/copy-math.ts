/**
 * Pure copy-trading math (no I/O): canonical legs of a verified leader
 * fill, follower sizing, exchange rounding and the paper ledger.
 *
 * Sizes and prices are carried as JS numbers only between these helpers;
 * anything stored or compared against an exchange rule is first rounded to
 * the asset's decimals (`floorSize`, `roundPx`) and written as a fixed
 * decimal string (`dec`).
 */
import { createHash } from "node:crypto";

import type { CopyDirection, CopySizingMode } from "@trading-dashboard/shared/contracts";

/** A verified leader fill, as stored in `fills.raw`. */
export interface LeaderFill {
  tid: bigint;
  coin: string;
  px: number;
  sz: number;
  side: "B" | "A";
  time: number;
  /** Signed leader position right before this fill; null when Hyperliquid didn't send it. */
  startPosition: number | null;
}

/**
 * One canonical leg of a leader fill.
 * - `open`: the leader's position grew by `size` on side `sign` (+1 long, −1 short).
 * - `close`: the leader's `sign` position shrank by `fraction` of what it was (0 < fraction ≤ 1).
 * A flip (long → short or back) is two legs: a full close of the old side and an open of the new.
 */
export type SignalLeg =
  | { tid: bigint; coin: string; time: number; px: number; leg: "open"; sign: 1 | -1; size: number }
  | { tid: bigint; coin: string; time: number; px: number; leg: "close"; sign: 1 | -1; size: number; fraction: number };

const EPS = 1e-12;
const signOf = (x: number): 1 | -1 | 0 => (x > EPS ? 1 : x < -EPS ? -1 : 0);

/** The legs of one fill, from its own startPosition, so fills can be
 * processed in any order. Null when the fill has no startPosition (it can't
 * be classified without guessing). */
export function legsOf(fill: LeaderFill): SignalLeg[] | null {
  if (fill.startPosition === null || !Number.isFinite(fill.startPosition)) return null;
  const start = fill.startPosition;
  const delta = fill.side === "B" ? fill.sz : -fill.sz;
  const end = start + delta;
  const s0 = signOf(start);
  const s1 = signOf(end);
  const base = { tid: fill.tid, coin: fill.coin, time: fill.time, px: fill.px };
  if (fill.sz <= EPS) return [];
  if (s0 === 0) return [{ ...base, leg: "open", sign: signOf(delta) as 1 | -1, size: fill.sz }];
  if (s1 === s0) {
    if (Math.abs(end) > Math.abs(start)) return [{ ...base, leg: "open", sign: s0, size: fill.sz }];
    return [{ ...base, leg: "close", sign: s0, size: fill.sz, fraction: Math.min(1, fill.sz / Math.abs(start)) }];
  }
  const close: SignalLeg = { ...base, leg: "close", sign: s0, size: Math.abs(start), fraction: 1 };
  if (s1 === 0) return [close];
  return [close, { ...base, leg: "open", sign: s1, size: Math.abs(end) }];
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
  leaderNotional: number;
  strategyEquity: number;
  leaderEquity: number | null;
}): number | null {
  if (args.mode === "fixed") return args.perTradeUsd && args.perTradeUsd > 0 ? args.perTradeUsd : null;
  if (args.leaderEquity === null || !(args.leaderEquity > 0) || !(args.strategyEquity > 0)) return null;
  return args.leaderNotional * (args.strategyEquity / args.leaderEquity);
}

/** Size to reduce when the leader closes `fraction` of their position:
 * the same fraction of the follower's own strategy position (never more). */
export function reduceSize(followerAbsSize: number, fraction: number): number {
  if (!(followerAbsSize > 0) || !(fraction > 0)) return 0;
  return fraction >= 1 - 1e-9 ? followerAbsSize : followerAbsSize * fraction;
}

/** Round a size down to the asset's `szDecimals` (Hyperliquid rejects more). */
export function floorSize(size: number, szDecimals: number): number {
  if (!(size > 0)) return 0;
  const f = 10 ** szDecimals;
  return Math.floor(size * f + 1e-9) / f;
}

/** Hyperliquid perp prices: at most 5 significant figures and at most
 * 6 − szDecimals decimals (integers always allowed). */
export function roundPx(px: number, szDecimals: number): number {
  if (!(px > 0)) return px;
  if (Number.isInteger(px)) return px;
  const sig = Number(px.toPrecision(5));
  const maxDecimals = Math.max(0, 6 - szDecimals);
  return Number(sig.toFixed(maxDecimals));
}

/** A fixed decimal string for numeric columns (8 dp, no exponent, no "-0"). */
export function dec(value: number, digits = 8): string {
  const s = (Math.abs(value) < 10 ** -digits / 2 ? 0 : value).toFixed(digits);
  return s.replace(/\.?0+$/, "") || "0";
}

/** The simulated execution price: `basePx` moved against the taker by `slippageBps`. */
export function slippedPx(basePx: number, side: "B" | "A", slippageBps: number): number {
  const k = slippageBps / 10_000;
  return side === "B" ? basePx * (1 + k) : basePx * (1 - k);
}

/** A position after one fill. `side` +1 buys, −1 sells; the fill never
 * crosses zero (flips arrive as a reduce-only close then an open). */
export function applyFill(pos: { size: number; entryPx: number }, sign: 1 | -1, size: number, px: number): { size: number; entryPx: number; realizedPnl: number } {
  const delta = sign * size;
  const current = pos.size;
  if (signOf(current) === 0 || signOf(current) === signOf(delta)) {
    const total = Math.abs(current) + size;
    const entryPx = total > 0 ? (Math.abs(current) * pos.entryPx + size * px) / total : px;
    return { size: current + delta, entryPx, realizedPnl: 0 };
  }
  const closed = Math.min(size, Math.abs(current));
  const realizedPnl = closed * (px - pos.entryPx) * signOf(current);
  const next = current + signOf(delta) * closed;
  return { size: Math.abs(next) < EPS ? 0 : next, entryPx: Math.abs(next) < EPS ? 0 : pos.entryPx, realizedPnl };
}

/** Taker and builder fees of a fill, in USDC. `builderFeeTenthsBps` is the
 * admin's revenue.builderFeeTenthsBps (1 = 0.001%). */
export function fillFees(notional: number, takerFeeBps: number, builderFeeTenthsBps: number): { fee: number; builderFee: number } {
  return { fee: (notional * takerFeeBps) / 10_000, builderFee: (notional * builderFeeTenthsBps) / 100_000 };
}

/** Funding a position pays for one hour (positive = paid, negative = received):
 * longs pay shorts when the rate is positive, as on Hyperliquid. */
export function fundingPayment(size: number, px: number, hourlyRate: number): number {
  return size * px * hourlyRate;
}

/** Deterministic client order id from the dedupe key (Hyperliquid's cloid
 * is 16 bytes hex): a retried order keeps its id, so testnet/live can look
 * it up instead of sending it twice. */
export function cloidOf(key: string): string {
  return "0x" + createHash("sha256").update(key).digest("hex").slice(0, 32);
}
