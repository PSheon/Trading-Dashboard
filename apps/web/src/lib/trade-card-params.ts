/** Query parameters of the trade / position card routes, validated. */
import { isShareFormat, type ShareFormat } from "@/lib/share-card";
import { isTradeCardStyle, type TradeCardStyle } from "@/lib/trade-card";

export const COIN_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,31}$/;
/** A trader's round-trip id: the tid of its first fill, negative for a partial trade. */
export const LEADER_TRADE_ID_RE = /^-?[1-9]\d{0,19}$/;
/** A copy trade's id: its opening paper fill (a positive bigint). */
export const COPY_TRADE_ID_RE = /^[1-9]\d{0,18}$/;

export type CardRequest =
  | { kind: "trade"; id: string; style: TradeCardStyle; format: ShareFormat }
  | { kind: "position"; coin: string; strategyId: number | null; style: TradeCardStyle; format: ShareFormat };

/** `copy`: the owner's copy routes (copy trade ids; a position needs its copy). */
export function parseCardRequest(params: URLSearchParams, copy: boolean): CardRequest | null {
  const style = params.get("style") ?? "card";
  const format = params.get("format") ?? "landscape";
  if (!isTradeCardStyle(style) || !isShareFormat(format)) return null;
  const kind = params.get("kind");
  if (kind === "trade") {
    const id = params.get("id") ?? "";
    return (copy ? COPY_TRADE_ID_RE : LEADER_TRADE_ID_RE).test(id) ? { kind, id, style, format } : null;
  }
  if (kind === "position") {
    const coin = params.get("coin") ?? "";
    if (!COIN_RE.test(coin)) return null;
    if (!copy) return { kind, coin, strategyId: null, style, format };
    const raw = params.get("strategyId") ?? "";
    const strategyId = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(strategyId) && strategyId <= 2_147_483_647 ? { kind, coin, strategyId, style, format } : null;
  }
  return null;
}
