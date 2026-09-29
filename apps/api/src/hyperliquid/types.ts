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
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
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

export interface HlUserFill {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B";
  time: number;
  startPosition?: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken?: string;
}

export type HlUserFillsByTimeResponse = HlUserFill[];

export type HlAllMidsResponse = Record<string, string>;

export type HlInfoRequestBody =
  | { type: "meta" }
  | { type: "clearinghouseState"; user: string }
  | {
      type: "userFillsByTime";
      user: string;
      startTime: number;
      endTime?: number;
    }
  | { type: "allMids" };

// ---------------------------------------------------------------------------
// WS: wss://api.hyperliquid.xyz/ws
// ---------------------------------------------------------------------------

export interface HlWsSubscribeUserFills {
  method: "subscribe";
  subscription: { type: "userFills"; user: string };
}

export interface HlWsSubscribeUserEvents {
  method: "subscribe";
  subscription: { type: "userEvents"; user: string };
}

export type HlWsSubscribeMessage =
  | HlWsSubscribeUserFills
  | HlWsSubscribeUserEvents;

export interface HlWsUserFillsEvent {
  channel: "userFills";
  data: {
    user: string;
    isSnapshot?: boolean;
    fills: HlUserFill[];
  };
}

/**
 * userEvents payload shape varies by event kind (fills, funding,
 * liquidation, ...). Left as `unknown` here — mapping to the official
 * schema is called out in the PRD as "型別需在實作時對照官方 schema" (§4.2 W5).
 */
export interface HlWsUserEventsEvent {
  channel: "userEvents";
  data: unknown;
}

export type HlWsIncomingMessage = HlWsUserFillsEvent | HlWsUserEventsEvent;
