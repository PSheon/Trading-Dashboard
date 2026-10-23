import type { TraderFill } from "@/lib/contracts";
import { coinDex } from "@/lib/format";

/** The exchange's minimum order; a policy can only raise it (api min-order-notional.ts). */
const EXCHANGE_MIN_NOTIONAL = 10;

export type CopyFit =
  | { status: "loading" | "no_amount" | "unknown_equity" | "no_opens" }
  | { status: "ok"; opens: number; belowMin: number; hip3: number; minNotional: number; from: Date; to: Date };

/** The opening size of a fill, in coins: all of an open, the part of a flip
 * past zero, nothing for a close, a spot trade or a flip whose start is unknown. */
function openSize(fill: TraderFill): number {
  if (fill.dir === "Open Long" || fill.dir === "Open Short") return fill.sz;
  if (fill.dir === "Long > Short" || fill.dir === "Short > Long") {
    if (fill.startPosition === null || fill.startPosition === undefined) return 0;
    return Math.max(0, fill.sz - Math.abs(fill.startPosition));
  }
  return 0;
}

/**
 * How a ratio copy of `allocation` would have sized the leader's recent
 * opens: each open scaled by allocation ÷ leader account value (copy-math
 * openNotional) and compared with the minimum order. The fills of one order
 * (same coin, direction and time) count as one, as the copy engine batches
 * them. An estimate on past fills: it does not see later PnL, caps, signal
 * age or the engine's exact batches. It suggests no amount: the one
 * suggested minimum budget is the api's (decision D7, the pill by the amount).
 */
export function estimateCopyFit({ fills, leaderEquity, allocation, minNotional = EXCHANGE_MIN_NOTIONAL }: {
  fills: readonly TraderFill[] | undefined; leaderEquity: number | null | undefined; allocation: number; minNotional?: number;
}): CopyFit {
  if (!(allocation > 0)) return { status: "no_amount" };
  if (!fills) return { status: "loading" };
  if (leaderEquity === null || leaderEquity === undefined || !(leaderEquity > 0)) return { status: "unknown_equity" };
  const min = Math.max(EXCHANGE_MIN_NOTIONAL, minNotional);
  const orders = new Map<string, { notional: number; hip3: boolean; at: number }>();
  for (const fill of fills) {
    const size = openSize(fill);
    if (!(size > 0)) continue;
    const at = Date.parse(fill.ts);
    const key = `${fill.coin}|${fill.dir}|${at}`;
    const order = orders.get(key) ?? { notional: 0, hip3: coinDex(fill.coin) !== null, at };
    order.notional += size * fill.px;
    orders.set(key, order);
  }
  if (orders.size === 0) return { status: "no_opens" };
  const scale = allocation / leaderEquity;
  let belowMin = 0, hip3 = 0, from = Infinity, to = -Infinity;
  for (const order of orders.values()) {
    from = Math.min(from, order.at);
    to = Math.max(to, order.at);
    if (order.hip3) { hip3 += 1; continue; }
    if (order.notional * scale < min) belowMin += 1;
  }
  return { status: "ok", opens: orders.size, belowMin, hip3, minNotional: min, from: new Date(from), to: new Date(to) };
}
