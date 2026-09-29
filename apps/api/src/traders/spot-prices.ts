import type { AccountMode, SpotBalance } from "@trading-dashboard/shared";

import type {
  HlAllMidsResponse,
  HlDelegatorSummary,
  HlSpotBalance,
  HlSpotMetaAndAssetCtxsResponse,
} from "../hyperliquid/types.js";

/** USDC, the quote of almost every spot pair. */
export const USDC_TOKEN = 0;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const positive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export interface TokenPrice {
  /** USD per unit. */
  px: number;
  /** The `allMids` key that moves with it, when that key is quoted in USDC
   * (a live client can use it as is); null otherwise. */
  key: string | null;
}

/** USD prices of every spot token and outcome token, built from one
 * `spotMetaAndAssetCtxs` and one `allMids`. */
export interface SpotPriceBook {
  byToken: Map<number, TokenPrice>;
  /** Outcome-token mids by `allMids` key ("#12301"). */
  outcomes: Map<string, number>;
  tokenByName: Map<string, number>;
}

/**
 * Prices every spot token in USD, the way Hyperliquid's portfolio totals do
 * (verified live 2026-09-29 against `portfolio` account values):
 *
 * - USDC is 1.
 * - A token with a USDC pair ("PURR/USDC", "@107" for HYPE) takes that
 *   pair's mark price (`markPx`), falling back to its mid. Hyperliquid
 *   values by mark: an illiquid pair whose mid is far off (FXMR, mid 30 vs
 *   mark 54.7) matched the portfolio total only at the mark.
 * - A token quoted only in another token (USDT0, USDH, USDE) takes that
 *   pair's mark × the quote token's USD price.
 * - Contexts are matched to pairs by name; the arrays are not aligned.
 * - Outcome tokens ("+12301") are priced from `allMids["#12301"]`.
 *
 * A token with none of these is left out (valued at 0 by the caller).
 */
export function buildSpotPriceBook(
  [meta, ctxs]: HlSpotMetaAndAssetCtxsResponse,
  mids: HlAllMidsResponse,
): SpotPriceBook {
  const ctxByCoin = new Map(ctxs.map((c) => [c.coin, c]));
  const byToken = new Map<number, TokenPrice>([[USDC_TOKEN, { px: 1, key: null }]]);
  const pairPx = (name: string): number | null => {
    const ctx = ctxByCoin.get(name);
    return positive(ctx?.markPx) ?? positive(ctx?.midPx) ?? positive(mids[name]);
  };
  // Canonical pairs first, so a token's original USDC market wins over a
  // later duplicate.
  const pairs = [...meta.universe].sort((a, b) => Number(b.isCanonical ?? false) - Number(a.isCanonical ?? false));
  for (const pair of pairs) {
    const [base, quote] = pair.tokens;
    if (quote !== USDC_TOKEN || byToken.has(base)) continue;
    const px = pairPx(pair.name);
    if (px !== null) byToken.set(base, { px, key: pair.name });
  }
  for (const pair of pairs) {
    const [base, quote] = pair.tokens;
    const quotePx = byToken.get(quote)?.px;
    if (byToken.has(base) || quotePx === undefined) continue;
    const px = pairPx(pair.name);
    if (px !== null) byToken.set(base, { px: px * quotePx, key: null });
  }
  const outcomes = new Map<string, number>();
  for (const [key, value] of Object.entries(mids)) {
    if (!key.startsWith("#")) continue;
    const px = Number(value);
    if (Number.isFinite(px) && px >= 0) outcomes.set(key, px);
  }
  return { byToken, outcomes, tokenByName: new Map(meta.tokens.map((t) => [t.name, t.index])) };
}

/** Where a balance's price comes from: its token, or its outcome key. */
function priceOf(balance: HlSpotBalance, book: SpotPriceBook): TokenPrice | null {
  if (balance.token === undefined || balance.token === null) {
    if (!balance.coin.startsWith("+")) return null;
    const key = `#${balance.coin.slice(1)}`;
    const px = book.outcomes.get(key);
    return px === undefined ? null : { px, key };
  }
  return book.byToken.get(balance.token) ?? null;
}

export interface SpotValuation {
  spotValue: number;
  /** Non-zero balances, largest value first. */
  balances: SpotBalance[];
}

/** Values spot balances with `book`. Unpriced balances count as 0 and are
 * reported through `onUnpriced` (once per call per coin). */
export function valueSpotBalances(
  balances: HlSpotBalance[],
  book: SpotPriceBook,
  onUnpriced: (coin: string, token: number | null) => void = () => undefined,
): SpotValuation {
  const out: SpotBalance[] = [];
  let spotValue = 0;
  for (const balance of balances) {
    const total = num(balance.total);
    if (total === 0) continue;
    const token = balance.token ?? null;
    const price = priceOf(balance, book);
    if (price === null) onUnpriced(balance.coin, token);
    const value = price === null ? 0 : total * price.px;
    spotValue += value;
    out.push({ coin: balance.coin, token, total, px: price?.px ?? null, value, priceKey: price?.key ?? null });
  }
  out.sort((a, b) => b.value - a.value);
  return { spotValue, balances: out };
}

/** Staked HYPE, in HYPE: delegated + undelegated (in the staking account,
 * not delegated) + pending withdrawals. */
export function stakedHype(summary: HlDelegatorSummary): number {
  return num(summary.delegated) + num(summary.undelegated) + num(summary.totalPendingWithdrawal);
}

/** HYPE's USD price from the book; 0 when it can't be priced. */
export function hypePrice(book: SpotPriceBook): number {
  const token = book.tokenByName.get("HYPE");
  return token === undefined ? 0 : (book.byToken.get(token)?.px ?? 0);
}

/** Hyperliquid's `userAbstraction` as our `AccountMode`. A spot state that
 * says portfolio margin is on wins, whatever the abstraction call said. */
export function toAccountMode(abstraction: string | null, portfolioMarginEnabled = false): AccountMode {
  if (portfolioMarginEnabled || abstraction === "portfolioMargin") return "portfolioMargin";
  if (abstraction === "unifiedAccount") return "unified";
  return "standard";
}

/**
 * Total equity as Hyperliquid's `portfolio` reports it (verified live
 * 2026-09-29 on 16 active accounts in every mode: within 0.05% except where
 * noted in the docs below):
 *
 * - standard: perp equity (every dex) + spot value + staked HYPE;
 * - unified / portfolio margin: spot value + staked HYPE. The spot
 *   clearinghouse already holds the perp collateral and PnL; adding the
 *   per-dex perp states would count it twice.
 *
 * Not included: borrow/lend positions outside portfolio margin (supplied
 * minus borrowed; seen on 1 of 16 accounts, 5%) and vault deposits.
 */
export function totalAccountValue(mode: AccountMode, perpEquity: number, spotValue: number, stakedValue: number): number {
  return (mode === "standard" ? perpEquity : 0) + spotValue + stakedValue;
}
