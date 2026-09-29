/**
 * Typed request/response shapes for the Hyperliquid public info & WS APIs
 * that the application consumes. HTTP payloads are runtime-validated in
 * response-validation.ts; additional fields are retained for forward compatibility.
 */

// ---------------------------------------------------------------------------
// info endpoint: POST https://api.hyperliquid.xyz/info
// ---------------------------------------------------------------------------

export interface HlMetaUniverseAsset {
  /** Main-dex coins are bare ("BTC"); HIP-3 coins carry their dex prefix
   * ("xyz:TSLA"). */
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
}

export interface HlMetaResponse {
  universe: HlMetaUniverseAsset[];
}

export interface HlAssetPosition {
  position: {
    coin: string;
    szi: string;
    entryPx?: string | null;
    leverage: { type: string; value: number };
    liquidationPx?: string | null;
    marginUsed: string;
    unrealizedPnl: string;
    /** |szi| × mark price, USD. */
    positionValue?: string;
  };
  type: string;
}

export interface HlClearinghouseStateResponse {
  assetPositions: HlAssetPosition[];
  crossMarginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  withdrawable: string;
  time: number;
}

/** Shape per the docs' `WsFill` (same objects as userFillsByTime). */
export interface HlUserFill {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B";
  time: number;
  /** Signed position size right before this fill. Classification uses this;
   * `dir` is documented as "used for frontend display". */
  startPosition?: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  /** Shared by both counterparties of the trade. */
  tid: number;
  liquidation?: {
    liquidatedUser?: string;
    markPx: number;
    method: "market" | "backstop";
  };
  feeToken?: string;
  builderFee?: string;
  /** On a TWAP slice fill, set by this app from the slice's outer `twapId`
   * (Hyperliquid's own `fill.twapId` inside a slice is null). */
  twapId?: number | null;
}

export type HlUserFillsByTimeResponse = HlUserFill[];

/**
 * One item of `userTwapSliceFills` / `userTwapSliceFillsByTime`. TWAP slice
 * fills are NOT in `userFills` / `userFillsByTime` (verified live
 * 2026-09-29: an account with 2,000 slices in the last day had its newest
 * `userFills` entry 6 days old), but the `trades` feed carries them like any
 * other trade, trader in `users[]`, same tid. The fill has every field a
 * normal fill has (startPosition, dir, closedPnl, fee, oid); its `hash` is
 * always 0x0…0.
 */
export interface HlTwapSliceFill {
  fill: HlUserFill;
  twapId: number;
}

/** `perpDexs`: index 0 is the main dex (returned as null); the rest are
 * HIP-3 builder dexes whose coins are named "<dex>:<COIN>". */
export type HlPerpDexsResponse = Array<{
  name: string;
  /** One entry per listed market; empty for a dex with nothing listed. */
  assetToStreamingOiCap?: Array<[string, string]>;
} | null>;

export type HlAllMidsResponse = Record<string, string>;

/** One `spotClearinghouseState` balance. Prediction-market outcome tokens
 * ("+12301") carry no `token` index; their price is `allMids["#12301"]`.
 * Portfolio-margin accounts add `supplied`, `ltv` and `spotHold` (verified
 * live 2026-09-29). */
export interface HlSpotBalance {
  coin: string;
  token?: number;
  total: string;
  hold: string;
  entryNtl: string;
  supplied?: string;
}

/** `spotClearinghouseState`: weight 2 (rate-limits-and-user-limits). In
 * unified and portfolio-margin accounts this holds every balance, perp
 * collateral included ("Individual perp dex user states are not
 * meaningful", account-abstraction-modes). */
export interface HlSpotClearinghouseStateResponse {
  balances: HlSpotBalance[];
  portfolioMarginEnabled?: boolean;
}

export interface HlSpotToken {
  name: string;
  index: number;
  szDecimals?: number;
}

/** A spot pair: `tokens` is [base, quote] by token index; `name` is
 * "PURR/USDC" for the first pair and "@<index>" for the rest, which is also
 * its `allMids` key. */
export interface HlSpotPair {
  name: string;
  index: number;
  tokens: [number, number];
  isCanonical?: boolean;
}

export interface HlSpotMeta {
  tokens: HlSpotToken[];
  universe: HlSpotPair[];
}

/** A pair's market context. Matched to its pair by `coin` = pair name: the
 * arrays are NOT index-aligned (verified live 2026-09-29: 71 of 330). */
export interface HlSpotAssetCtx {
  coin: string;
  markPx: string;
  midPx?: string | null;
  prevDayPx?: string;
  dayNtlVlm?: string;
}

export type HlSpotMetaAndAssetCtxsResponse = [HlSpotMeta, HlSpotAssetCtx[]];

/** `userAbstraction`: "unifiedAccount", "portfolioMargin", "disabled",
 * "default" or "dexAbstraction" (info-endpoint docs). */
export type HlUserAbstractionResponse = string;

/** `delegatorSummary`: the address's HYPE staking, in HYPE. */
export interface HlDelegatorSummary {
  delegated: string;
  undelegated: string;
  totalPendingWithdrawal: string;
  nPendingWithdrawals: number;
}

export type HlInfoRequestBody =
  | { type: "meta"; dex?: string }
  | { type: "perpDexs" }
  | { type: "clearinghouseState"; user: string; dex?: string }
  | {
      type: "userFillsByTime";
      user: string;
      startTime: number;
      endTime?: number;
    }
  | { type: "allMids" }
  | { type: "spotClearinghouseState"; user: string }
  | { type: "spotMetaAndAssetCtxs" }
  | { type: "userAbstraction"; user: string }
  | { type: "delegatorSummary"; user: string }
  | { type: "portfolio"; user: string }
  | { type: "userFills"; user: string }
  | { type: "userTwapSliceFills"; user: string }
  | {
      type: "userTwapSliceFillsByTime";
      user: string;
      startTime: number;
      endTime?: number;
    }
  | { type: "referral"; user: string }
  | { type: "userFunding"; user: string; startTime: number; endTime?: number };

/** One `userFunding` entry: a funding payment on one position. Recent ones
 * are hourly; older ones are daily sums (`nSamples` hours, stamped 00:00
 * UTC; verified live 2026-09-29). `usdc` < 0 means paid. */
export interface HlUserFundingEntry {
  time: number;
  hash: string;
  delta: {
    type: "funding";
    coin: string;
    usdc: string;
    szi: string;
    fundingRate: string;
    nSamples?: number | null;
  };
}

/** One `portfolio` history: [epoch ms, decimal string] points. */
export interface HlPortfolioHistory {
  accountValueHistory: Array<[number, string]>;
  pnlHistory: Array<[number, string]>;
  vlm: string;
}

/** `portfolio`: `[["day", …], ["week", …], ["month", …], ["allTime", …],
 * ["perpDay", …], ["perpWeek", …], ["perpMonth", …], ["perpAllTime", …]]`. */
export type HlPortfolioResponse = Array<[string, HlPortfolioHistory]>;

/** Cumulative reward counters. The top-level fields of the `referral`
 * response are USDC (token 0) only; other tokens appear in `tokenToState`. */
export interface HlReferralRewardState {
  cumVlm: string;
  /** Includes unclaimed builder rewards (verified live 2026-09-29: an
   * address with only builder income has unclaimed = builderRewards). */
  unclaimedRewards: string;
  claimedRewards: string;
  builderRewards: string;
}

/** One user referred by the queried address (stage "ready"). */
export interface HlReferralState {
  /** The referred user's cumulative volume, USDC (token 0). */
  cumVlm: string;
  cumRewardedFeesSinceReferred: string;
  /** Fees paid to the referrer (the queried address) by this user, USDC. */
  cumFeesRewardedToReferrer: string;
  timeJoined: number;
  user: string;
  tokenToState?: Array<[number, Partial<HlReferralState>]>;
}

/** `referrerState`: "needToTrade" (below the $10k volume needed to create a
 * code; data = {required}), "needToCreateCode" (no data), "ready" (has a
 * code; data = {code, nReferrals, referralStates}). Verified live
 * 2026-09-29 against the docs' "Query a user's referral information". */
export type HlReferrerState =
  | { stage: "ready"; data: { code: string; nReferrals?: number; referralStates: HlReferralState[] } }
  | { stage: "needToTrade"; data?: { required: string } }
  | { stage: "needToCreateCode"; data?: unknown }
  | { stage: string; data?: unknown };

/** `info {"type":"referral","user":…}`. */
export interface HlReferralResponse extends HlReferralRewardState {
  referredBy: { referrer: string; code: string } | null;
  referrerState: HlReferrerState;
  /** Legacy. */
  rewardHistory: unknown[];
  tokenToState: Array<[number, HlReferralRewardState]>;
}

// ---------------------------------------------------------------------------
// WS: wss://api.hyperliquid.xyz/ws
//
// Only the per-coin `trades` channel is used. User-specific channels
// (userFills, userEvents, …) are capped at 10 unique users per IP; `trades`
// is not user-specific, and every trade names both counterparties.
// ---------------------------------------------------------------------------

export interface HlWsTrade {
  coin: string;
  side: "A" | "B";
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
  /** [buyer, seller], lowercase hex. */
  users: [string, string];
}

export type HlWsIncomingMessage =
  | { channel: "trades"; data: HlWsTrade[] }
  | { channel: "subscriptionResponse"; data: unknown }
  | { channel: "pong" }
  | { channel: "error"; data: string }
  | { channel: string; data?: unknown };
