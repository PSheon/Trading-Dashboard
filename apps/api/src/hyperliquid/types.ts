/**
 * Typed request/response shapes for the Hyperliquid public info & WS APIs
 * that this PRD needs (§5). These are intentionally loose (fields the docs
 * document, `unknown`/optional elsewhere) — tightening them is part of the
 * next task, not this scaffold.
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
    entryPx?: string;
    leverage: { type: string; value: number };
    liquidationPx?: string | null;
    marginUsed: string;
    unrealizedPnl: string;
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
}

export type HlUserFillsByTimeResponse = HlUserFill[];

/** `perpDexs`: index 0 is the main dex (returned as null); the rest are
 * HIP-3 builder dexes whose coins are named "<dex>:<COIN>". */
export type HlPerpDexsResponse = Array<{ name: string } | null>;

export type HlAllMidsResponse = Record<string, string>;

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
  | { type: "allMids" };

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
