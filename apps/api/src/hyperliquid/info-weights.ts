/**
 * Hyperliquid's REST `info` weights, the one table every budget derives from
 * (rate-limits-and-user-limits, checked 2026-10-12; 1200 a minute per IP):
 * - 2: l2Book, allMids, clearinghouseState, orderStatus, spotClearinghouseState, exchangeStatus;
 * - 60: userRole;
 * - 20: every other documented info request;
 * - plus 1 per 20 items returned for the list requests below, 1 per 60 for candleSnapshot.
 * (Explorer requests weigh 40; none goes through these clients.)
 * The info client (local scheduling), the shared per-IP meter
 * (hyperliquid-global-transport.ts) and live evidence (live-shared-reads.ts)
 * read this table: they used to keep three that disagreed.
 */
const CHEAP: ReadonlySet<string> = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);
/** The docs' "additional weight per 20 items returned" list, plus
 * userNonFundingLedgerUpdates (not listed; budgeted as one, conservatively). */
const PER_20_ITEMS: ReadonlySet<string> = new Set(['recentTrades', 'historicalOrders', 'userFills', 'userFillsByTime', 'fundingHistory', 'userFunding',
  'nonUserFundingUpdates', 'twapHistory', 'userTwapSliceFills', 'userTwapSliceFillsByTime', 'delegatorHistory', 'delegatorRewards', 'validatorStats',
  'userNonFundingLedgerUpdates']);
export const USER_ROLE_WEIGHT = 60;
export const EXPLORER_WEIGHT = 40;
/** Every list request answers at most this many items. */
export const MAX_INFO_LIST_ITEMS = 2000;
/** candleSnapshot answers at most this many candles. */
export const MAX_CANDLES = 5000;

/** The provider weight of one info request before any list surcharge. */
export function infoWeight(body: Readonly<{ type?: unknown }>): number {
  const type = String(body.type);
  return CHEAP.has(type) ? 2 : type === 'userRole' ? USER_ROLE_WEIGHT : 20;
}
/** Items per extra weight for a list request (20, candles 60); undefined when it is no list. */
export function infoItemsPerWeight(type: string): 20 | 60 | undefined {
  return PER_20_ITEMS.has(type) ? 20 : type === 'candleSnapshot' ? 60 : undefined;
}
export const isInfoList = (type: string) => infoItemsPerWeight(type) !== undefined;
/** The surcharge of a list answer of `items` items (0 for a request that is no list). */
export function infoListSurcharge(type: string, items: number): number {
  const per = infoItemsPerWeight(type);
  return per === undefined ? 0 : Math.ceil(Math.min(Math.max(0, items), type === 'candleSnapshot' ? MAX_CANDLES : MAX_INFO_LIST_ITEMS) / per);
}
/** What a request may weigh at most: a list prepays its largest answer
 * (120 for a list, 104 for candles), as the shared meter charges it. */
export function infoPrepaidWeight(body: Readonly<{ type?: unknown }>): number {
  const type = String(body.type);
  return infoWeight(body) + infoListSurcharge(type, type === 'candleSnapshot' ? MAX_CANDLES : MAX_INFO_LIST_ITEMS);
}
/** The summed prepaid weight of several requests (one meter charge). */
export const infoPrepaidWeights = (bodies: readonly Readonly<{ type?: unknown }>[]) => bodies.reduce((sum, body) => sum + infoPrepaidWeight(body), 0);
