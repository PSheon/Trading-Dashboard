import { Dec } from "../common/decimal/dec.js";
import { publicOrderReason } from "../copy/copy-order-reason.js";

/**
 * Refusals of an actual copy's leg that are bookkeeping, not an order the
 * owner lost, so the trade bot says nothing:
 * - `merged_into_adjustment`: the leg went out inside its lead's order (that
 *   one is the message);
 * - `position_closed_by_owner`: the owner closed it themselves;
 * - `copy_stopping`: the owner stopped the copy (the stop is the message);
 * - `no_follower_position`, `flip_close_not_settled`: the follow-up of an
 *   open or close already refused (and sent);
 * - `fixed_trade_already_claimed`: the same leader trade was already copied;
 * - `no_copyable_leg`: the leader fill changed nothing to copy.
 */
export const SILENT_LIVE_REFUSALS = ["merged_into_adjustment", "position_closed_by_owner", "copy_stopping", "no_follower_position",
  "flip_close_not_settled", "fixed_trade_already_claimed", "no_copyable_leg"] as const;

/** A terminal live row that is an owner event the trade bot sends (see
 * NotifyRepository.projectLiveCopyEvents). Amounts are decimal text. */
export type LiveCopySource = {
  source: string; userId: number; strategyId: number; network: string; type: string; coin: string | null; reason: string | null; amount: string | null;
  /** Of a settled leg: its order's own fills (copy_follower_receipts). */
  size: string | null; px: string | null; side: string | null; sides: number | null; pnl: string | null; fee: string | null; start: string | null;
};

/** What a fill of `size` on `side` did to a position of `startPosition`
 * (signed, before the fill); null when unknown or a flip (said as a plain fill). */
export function liveFillAction(side: unknown, size: unknown, startPosition: unknown): "open" | "increase" | "decrease" | "close" | null {
  const start = Dec.parse(startPosition), sz = Dec.parse(size);
  if (!start || !sz || (side !== "B" && side !== "A")) return null;
  if (start.eq(0)) return "open";
  if (start.gt(0) === (side === "B")) return "increase";
  const cmp = sz.cmp(start.abs());
  return cmp === 0 ? "close" : cmp < 0 ? "decrease" : null;
}

/** The owner event's payload: the renderer's allowlisted fields only (never
 * an address, a signature or an internal refusal code), its mode from the
 * copy's network and `liveSource`, the row it was projected from. */
export function liveCopyPayload(row: LiveCopySource): Record<string, unknown> {
  const base = { mode: row.network === "mainnet" ? "live" : "testnet", liveSource: row.source };
  if (row.type === "order_rejected") return { ...base, coin: row.coin, reason: publicOrderReason(row.reason) };
  if (row.type === "order_filled") {
    // Fills of both sides (never one order's) say no size rather than a wrong one.
    const fill = row.sides === 1 ? { side: row.side, size: row.size, px: row.px } : {};
    const action = row.sides === 1 ? liveFillAction(row.side, row.size, row.start) : null;
    return { ...base, coin: row.coin, ...fill, ...(action ? { action } : {}), realizedPnl: row.pnl, fee: row.fee };
  }
  if (row.type === "funds_returned" || row.type === "funds_withdrawn") return { ...base, amount: row.amount };
  return base;
}
