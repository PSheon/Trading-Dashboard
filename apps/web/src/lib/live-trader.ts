/**
 * Live trader-page state from Hyperliquid's WebSocket: a pure reducer over
 * the subscribed channels, and `deriveLiveProfile`, which lays the live data
 * over the REST profile (the initial state and the fallback) with the same
 * rules the api uses (`apps/api/src/traders/spot-prices.ts`).
 *
 * Channels (shapes verified live 2026-09-29):
 * - `clearinghouseState` {dex, user, clearinghouseState}: one per perp dex
 *   ("" = main), every few seconds: equity, margin, positions.
 * - `spotState` {user, spotState: {balances}}: spot balances (in unified /
 *   portfolio-margin accounts, all collateral).
 * - `webData3` {userState: {abstraction, …}}: the account mode.
 * - `allMids` {mids} and {dex, mids}: mids of main-dex perps, spot pairs
 *   ("@107") and outcomes ("#123"); one message per HIP-3 dex.
 * - `userFills` {isSnapshot?, user, fills} and `userTwapSliceFills`
 *   {isSnapshot?, user, twapSliceFills: [{fill, twapId}]}: a snapshot of
 *   recent fills first, then each new one.
 */
import type { AccountMode, LivePosition, SpotBalance, TraderFill, TraderProfileResponse } from "@/lib/contracts";

// --- wire shapes -------------------------------------------------------------

export interface WsAssetPosition {
  position: {
    coin: string;
    szi: string;
    entryPx?: string | null;
    positionValue?: string | null;
    unrealizedPnl?: string | null;
    liquidationPx?: string | null;
    leverage?: { type?: string; value?: number } | null;
    marginUsed?: string | null;
    returnOnEquity?: string | null;
    cumFunding?: { sinceOpen?: string | null } | null;
  };
}

export interface WsClearinghouseState {
  dex?: string;
  user?: string;
  clearinghouseState: {
    marginSummary: { accountValue: string; totalMarginUsed: string };
    crossMaintenanceMarginUsed?: string | null;
    withdrawable: string;
    assetPositions: WsAssetPosition[];
  };
}

export interface WsSpotBalance {
  coin: string;
  token?: number;
  total: string;
  hold?: string;
}

export interface WsFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  dir: string;
  closedPnl?: string | null;
  fee?: string | null;
  tid: number;
  twapId?: number | null;
  startPosition?: string | null;
  liquidation?: unknown;
}

export type LiveEvent =
  | { type: "clearinghouseState"; data: WsClearinghouseState; at: number }
  | { type: "spotState"; data: { spotState?: { balances?: WsSpotBalance[] } }; at: number }
  | { type: "webData3"; data: { userState?: { abstraction?: string } } }
  | { type: "allMids"; data: { dex?: string; mids?: Record<string, string> } }
  | { type: "userFills"; data: { isSnapshot?: boolean; fills?: WsFill[] } }
  | { type: "userTwapSliceFills"; data: { isSnapshot?: boolean; twapSliceFills?: Array<{ fill: WsFill; twapId: number }> } };

// --- state -------------------------------------------------------------------

export interface LivePerpDex {
  perpEquity: number;
  marginUsed: number;
  maintenanceMarginUsed: number;
  withdrawable: number;
  positions: LivePosition[];
}

export interface LiveTraderState {
  /** By dex ("" = main), as last received. */
  perp: Record<string, LivePerpDex>;
  /** Null until the first `spotState`. */
  spot: WsSpotBalance[] | null;
  /** Latest mid per `allMids` key, every dex merged (keys don't collide:
   * "BTC", "xyz:TSLA", "@107", "#123"). */
  mids: Record<string, number>;
  /** Hyperliquid's `userState.abstraction`; null until `webData3`. */
  abstraction: string | null;
  /** Fills (perp and spot) seen on the socket, newest first, one per tid. */
  fills: TraderFill[];
  /** When the last account message (not mids) arrived, epoch ms. */
  updatedAt: number | null;
}

export const initialLiveState: LiveTraderState = {
  perp: {},
  spot: null,
  mids: {},
  abstraction: null,
  fills: [],
  updatedAt: null,
};

/** Live fills kept in memory; the fills tab shows 200. */
export const MAX_LIVE_FILLS = 500;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Spot fills name a pair ("PURR/USDC") or index ("@107"), like the api's
 * `isPerpCoin`. */
export function isPerpCoin(coin: string): boolean {
  return !coin.startsWith("@") && !coin.includes("/");
}

/** A position's dex: the prefix of "xyz:TSLA", "" for the main dex. */
export function dexOf(coin: string): string {
  const i = coin.indexOf(":");
  return i >= 0 ? coin.slice(0, i) : "";
}

/** The same mapping as the api's `summarizeAccount`. */
export function toLivePosition(p: WsAssetPosition["position"]): LivePosition | null {
  const szi = num(p.szi);
  if (szi === 0) return null;
  const entryPx = numOrNull(p.entryPx);
  return {
    coin: p.coin,
    szi,
    side: szi > 0 ? "long" : "short",
    entryPx,
    positionValue: numOrNull(p.positionValue) ?? (entryPx === null ? 0 : Math.abs(szi) * entryPx),
    unrealizedPnl: num(p.unrealizedPnl),
    leverage: numOrNull(p.leverage?.value),
    marginMode: p.leverage?.type ?? null,
    liqPx: numOrNull(p.liquidationPx),
    marginUsed: num(p.marginUsed),
    fundingSinceOpen: numOrNull(p.cumFunding?.sinceOpen),
    returnOnEquity: numOrNull(p.returnOnEquity),
  };
}

/** A WS fill as the fills tab's row (the REST `TraderFill`, JSON form). */
export function toTraderFill(f: WsFill, twapId: number | null = f.twapId ?? null): TraderFill {
  const px = num(f.px);
  const sz = num(f.sz);
  return {
    tid: String(f.tid),
    coin: f.coin,
    side: f.side === "B" ? "buy" : "sell",
    dir: f.dir,
    px,
    sz,
    notionalUsd: px * sz,
    closedPnl: numOrNull(f.closedPnl),
    fee: numOrNull(f.fee),
    ts: new Date(f.time).toISOString(),
    twapId,
    startPosition: numOrNull(f.startPosition),
    liquidation: f.liquidation != null,
  };
}

const tsOf = (f: TraderFill) => new Date(f.ts).getTime();

/**
 * Merges fill lists newest first, one row per tid. When a tid comes twice
 * (a TWAP slice can arrive on both fill channels), the copy that names its
 * TWAP wins.
 */
export function mergeFills(...lists: TraderFill[][]): TraderFill[] {
  const byTid = new Map<string, TraderFill>();
  for (const list of lists) {
    for (const f of list) {
      const seen = byTid.get(f.tid);
      if (!seen || (seen.twapId == null && f.twapId != null)) byTid.set(f.tid, f);
    }
  }
  return [...byTid.values()].sort((a, b) => tsOf(b) - tsOf(a) || (a.tid < b.tid ? 1 : -1));
}

/** Perp and spot fills alike, as the 成交 tab and live feed list them
 * (CopyDog's). */
function addFills(state: LiveTraderState, incoming: TraderFill[]): LiveTraderState {
  if (incoming.length === 0) return state;
  return { ...state, fills: mergeFills(incoming, state.fills).slice(0, MAX_LIVE_FILLS) };
}

export function liveTraderReducer(state: LiveTraderState, event: LiveEvent | { type: "reset" }): LiveTraderState {
  switch (event.type) {
    case "reset":
      return initialLiveState;
    case "clearinghouseState": {
      const ch = event.data.clearinghouseState;
      if (!ch) return state;
      const dex = event.data.dex ?? "";
      const positions = (ch.assetPositions ?? [])
        .map((a) => toLivePosition(a.position))
        .filter((p): p is LivePosition => p !== null);
      return {
        ...state,
        perp: {
          ...state.perp,
          [dex]: {
            perpEquity: num(ch.marginSummary?.accountValue),
            marginUsed: num(ch.marginSummary?.totalMarginUsed),
            maintenanceMarginUsed: num(ch.crossMaintenanceMarginUsed),
            withdrawable: num(ch.withdrawable),
            positions,
          },
        },
        updatedAt: event.at,
      };
    }
    case "spotState": {
      const balances = event.data.spotState?.balances;
      if (!balances) return state;
      return { ...state, spot: balances, updatedAt: event.at };
    }
    case "webData3": {
      const abstraction = event.data.userState?.abstraction;
      return typeof abstraction === "string" && abstraction !== state.abstraction ? { ...state, abstraction } : state;
    }
    case "allMids": {
      const mids = event.data.mids;
      if (!mids) return state;
      const next = { ...state.mids };
      for (const [key, value] of Object.entries(mids)) {
        const n = Number(value);
        if (Number.isFinite(n)) next[key] = n;
      }
      return { ...state, mids: next };
    }
    case "userFills":
      return addFills(state, (event.data.fills ?? []).map((f) => toTraderFill(f)));
    case "userTwapSliceFills":
      return addFills(state, (event.data.twapSliceFills ?? []).map((s) => toTraderFill(s.fill, s.twapId)));
  }
}

// --- derived view ------------------------------------------------------------

export function toAccountMode(abstraction: string | null, fallback: AccountMode): AccountMode {
  if (abstraction === null) return fallback;
  if (abstraction === "portfolioMargin") return "portfolioMargin";
  if (abstraction === "unifiedAccount") return "unified";
  // A portfolio-margin spot flag can't be seen on the socket; keep the api's
  // answer for it.
  return fallback === "portfolioMargin" ? fallback : "standard";
}

/** A live mid replaces the api's mark only while it is within this of it:
 * Hyperliquid values spot by mark, and an illiquid pair's mid can be far
 * off (FXMR: mid 30 vs mark 54.7 on 2026-09-29). */
export const MID_TOLERANCE = 0.1;

/** The price a spot balance is valued at: 1 for USDC; else the live mid of
 * its `priceKey` when close to the api's mark; else that mark; outcome
 * tokens the api didn't know yet at their live mid. */
export function spotPrice(
  coin: string,
  token: number | null,
  rest: Pick<SpotBalance, "px" | "priceKey"> | undefined,
  mids: Record<string, number>,
): number | null {
  if (token === 0) return 1;
  const key = rest?.priceKey ?? (coin.startsWith("+") ? `#${coin.slice(1)}` : null);
  const mid = key === null ? undefined : mids[key];
  const restPx = rest?.px ?? null;
  if (mid === undefined) return restPx;
  if (restPx === null) return coin.startsWith("+") ? mid : null;
  return Math.abs(mid / restPx - 1) <= MID_TOLERANCE ? mid : restPx;
}

/** Spot balances valued with live prices, largest first. */
export function liveSpotBalances(
  restBalances: SpotBalance[],
  live: WsSpotBalance[] | null,
  mids: Record<string, number>,
): SpotBalance[] {
  const restByCoin = new Map(restBalances.map((b) => [b.coin, b]));
  const source = live
    ? live.map((b) => ({ coin: b.coin, token: b.token ?? null, total: num(b.total), hold: num(b.hold) }))
    : restBalances.map((b) => ({ coin: b.coin, token: b.token, total: b.total, hold: b.hold ?? 0 }));
  return source
    .filter((b) => b.total !== 0)
    .map((b) => {
      const rest = restByCoin.get(b.coin);
      const px = spotPrice(b.coin, b.token, rest, mids);
      return {
        coin: b.coin,
        token: b.token,
        total: b.total,
        hold: b.hold,
        px,
        value: px === null ? 0 : b.total * px,
        priceKey: rest?.priceKey ?? (b.coin.startsWith("+") ? `#${b.coin.slice(1)}` : null),
      };
    })
    .sort((a, b) => b.value - a.value);
}

/**
 * The profile with live data laid over it:
 *
 * - positions: per dex, the live list once that dex's `clearinghouseState`
 *   arrived, else the REST one;
 * - perp equity, margin used, withdrawable: live once every dex the api
 *   queried has reported, else REST;
 * - spot: live balances (or REST) at live prices;
 * - account value: the api's rule — perp + spot + staked, without perp in a
 *   unified / portfolio-margin account. Staking stays the REST value.
 */
export function deriveLiveProfile(profile: TraderProfileResponse, state: LiveTraderState): TraderProfileResponse {
  // A partial REST snapshot lacks verified coverage/accounting inputs. Keep it
  // explicit until a complete REST refresh; socket ticks must not turn null into zero.
  if (profile.dataQuality?.partial) return profile;
  const liveDexes = Object.keys(state.perp);
  const hasAccountData = liveDexes.length > 0 || state.spot !== null || Object.keys(state.mids).length > 0;
  if (!hasAccountData && state.abstraction === null) return profile;

  const dexes = [...new Set([...profile.perpDexes, ...liveDexes])];
  const positions = dexes
    .flatMap((dex) => state.perp[dex]?.positions ?? profile.positions.filter((p) => dexOf(p.coin) === dex))
    .sort((a, b) => b.positionValue - a.positionValue);
  const allDexesLive = profile.perpDexes.length > 0 && profile.perpDexes.every((dex) => state.perp[dex]);
  const sum = (pick: (d: LivePerpDex) => number) => liveDexes.reduce((s, dex) => s + pick(state.perp[dex]), 0);
  const perpEquity = allDexesLive ? sum((d) => d.perpEquity) : profile.perpEquity;
  const marginUsed = allDexesLive ? sum((d) => d.marginUsed) : profile.marginUsed;
  const maintenanceMarginUsed = allDexesLive ? sum((d) => d.maintenanceMarginUsed) : (profile.maintenanceMarginUsed ?? null);
  const withdrawable = allDexesLive ? sum((d) => d.withdrawable) : profile.withdrawable;

  const spotBalances = liveSpotBalances(profile.spotBalances, state.spot, state.mids);
  const spotValue = spotBalances.reduce((s, b) => s + b.value, 0);
  const accountMode = toAccountMode(state.abstraction, profile.accountMode);
  const accountValue = perpEquity === null || profile.stakedValue === null ? null : (accountMode === "standard" ? perpEquity : 0) + spotValue + profile.stakedValue;

  let longNotional = 0;
  let shortNotional = 0;
  for (const p of positions) {
    if (p.side === "long") longNotional += p.positionValue;
    else shortNotional += p.positionValue;
  }
  return {
    ...profile,
    positions,
    perpEquity,
    marginUsed,
    maintenanceMarginUsed,
    withdrawable,
    spotBalances,
    spotValue,
    accountMode,
    accountValue,
    longNotional,
    shortNotional,
  };
}

/** The live fills newer than the oldest REST row, merged in: a snapshot on
 * the socket can fill the gap of a REST list cached a few minutes, but
 * mustn't stretch the list past what REST shows. */
export function mergeLiveFills(rest: TraderFill[] | undefined, live: TraderFill[]): TraderFill[] | undefined {
  if (!rest) return rest;
  if (live.length === 0) return rest;
  const oldest = rest.length > 0 ? Math.min(...rest.map(tsOf)) : -Infinity;
  const fresh = live.filter((f) => tsOf(f) >= oldest);
  return fresh.length === 0 ? rest : mergeFills(fresh, rest);
}

/** The subscriptions for one trader page. */
export function traderSubscriptions(address: string, perpDexes: string[]) {
  const user = address.toLowerCase();
  const dexes = perpDexes.length > 0 ? perpDexes : [""];
  return [
    { type: "webData3" as const, user },
    { type: "spotState" as const, user },
    { type: "userFills" as const, user },
    { type: "userTwapSliceFills" as const, user },
    ...dexes.map((dex) => ({ type: "clearinghouseState" as const, user, dex })),
    ...dexes.map((dex) => ({ type: "allMids" as const, dex })),
  ];
}
