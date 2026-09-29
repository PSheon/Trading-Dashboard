import type { RoundTrip } from "@trading-dashboard/shared/contracts";

import type { HlUserFill } from "../hyperliquid/types.js";
import {
  executionOrder,
  fromScaled,
  isOutOfScopeSpotFill,
  liquidates,
  signedSize,
  toScaled,
} from "../watcher/action-classifier.js";

/**
 * Round-trip trades from fills, for any address, as CopyDog defines them
 * (its 交易 / 表現 tabs; reverse-engineered from its public API and bundle,
 * see docs/trade-analytics.md).
 *
 * A trade opens when a coin's position leaves 0 and closes when it returns
 * to 0, or flips: a fill that takes a long through zero into a short closes
 * the long with the part of its size that reaches zero and opens the short
 * with the rest (its fee and `closedPnl` both belong to
 * the closing leg, which is where Hyperliquid books it). Adds and reduces
 * stay inside the trade. Every fill carries `startPosition`, the position
 * right before it, so the boundaries are exact; fills sharing a
 * millisecond are put in execution order by chaining those positions
 * (`executionOrder`, the same rule the action classifier uses).
 *
 * Per trade: size = Σ every fill that grew the position; entry price is
 * their volume-weighted average and exit price that of every fill that
 * shrank it; gross PnL = Σ `closedPnl` (Hyperliquid's own, before fees);
 * fees = Σ `fee`; net = gross − fees (a win is net > 0). Funding is added
 * separately (`attributeFunding`) and isn't in net. TWAP slices are fills
 * like any other.
 *
 * History that starts mid-position (the first fill we hold for a coin
 * doesn't start from 0: older fills are beyond Hyperliquid's retention or
 * the lookback) gives a *partial* trade, as on CopyDog: its entry time is
 * that first fill ("before …"), the unseen part of its size is the
 * position before it, and that part's price is solved from the first
 * closing fill's `closedPnl` (Hyperliquid books closedPnl against the
 * position's average entry, so the entry price is exact). Until a closing
 * fill arrives its entry price covers only the fills we hold
 * (`entryApprox`).
 *
 * A trade the exchange closed (auto-deleveraging, settlement of a delisted
 * market) is dropped, as CopyDog leaves it out.
 *
 * A fill that doesn't start where the running trade stands (a fill missing
 * from the data) resyncs to it: a same-side jump just continues, anything
 * else drops the trade rather than guessing.
 *
 * Reconstruction is incremental: `applyFills` continues from the trades
 * still open after the previous batch, so a refresh only reads new fills.
 */
export type TradeSide = "long" | "short";

export interface Trade {
  coin: string;
  /** tid of the trade's first fill we hold (negated for a partial trade);
   * unique per address. */
  openTid: bigint;
  side: TradeSide;
  entryTime: number;
  /** Null while open. */
  exitTime: number | null;
  /** Signed size now, scaled (`toScaled`); 0n once closed. */
  position: bigint;
  /** Size already open before the first fill we hold (partial trades),
   * scaled; 0n for a trade we saw open. */
  preSize: bigint;
  /** Price of `preSize`, solved at the first closing fill; null before. */
  prePx: number | null;
  /** Σ size and notional of the fills that grew the position (with
   * `preSize` at `prePx` folded in once known). */
  entrySz: number;
  entryNtl: number;
  exitSz: number;
  exitNtl: number;
  realizedPnl: number;
  fees: number;
  /** Null when funding wasn't read for the whole hold. */
  funding: number | null;
  liquidated: boolean;
  twap: boolean;
  fills: number;
  lastFillTime: number;
}

/** Closes the exchange forces on a position (auto-deleveraging against a
 * liquidation, a delisted market's settlement). CopyDog counts no trade
 * that ends in one (checked: 0xf62e…'s ETH ADL of 2025-10-10 and ZEREBRO
 * settlement, 0xeadc…'s hyna settlements are all missing from its ledger). */
export const FORCED_CLOSE_DIRS = new Set(["Auto-Deleveraging", "Settlement"]);

const sign = (v: bigint): -1 | 0 | 1 => (v > 0n ? 1 : v < 0n ? -1 : 0);
const abs = (v: bigint): bigint => (v < 0n ? -v : v);
/** Scaled size → number, for price × size arithmetic. */
const toNumber = (scaled: bigint): number => Number(fromScaled(scaled));
const num = (v: string | undefined | null): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function isClosed(trade: Trade): boolean {
  return trade.exitTime !== null;
}

export function isPartial(trade: Trade): boolean {
  return trade.preSize > 0n;
}

/** A partial trade whose unseen part has no price yet. */
export function isEntryApprox(trade: Trade): boolean {
  return trade.preSize > 0n && trade.prePx === null;
}

export function entryPx(trade: Trade): number {
  return trade.entrySz > 0 ? trade.entryNtl / trade.entrySz : 0;
}

export function exitPx(trade: Trade): number | null {
  return trade.exitSz > 0 ? trade.exitNtl / trade.exitSz : null;
}

/** CopyDog's size: everything that went in. A partial trade still without
 * a price for its unseen part counts it at the position it has now. */
export function tradeSize(trade: Trade): number {
  return isEntryApprox(trade) ? Math.max(trade.entrySz, toNumber(abs(trade.position))) : trade.entrySz;
}

export function netPnl(trade: Trade): number {
  return trade.realizedPnl - trade.fees;
}

/** Closed: exit − entry; open: `now` − entry. Seconds. */
export function holdSeconds(trade: Trade, now: number): number {
  return Math.max(0, ((trade.exitTime ?? now) - trade.entryTime) / 1000);
}

function newTrade(fill: HlUserFill, position: bigint, preSize: bigint, fundingFrom: number | null): Trade {
  return {
    coin: fill.coin,
    // A partial trade's first held fill can also open the next trade (a
    // flip): partial trades take the negative tid so the two stay apart.
    openTid: preSize > 0n ? -BigInt(fill.tid) : BigInt(fill.tid),
    side: position > 0n ? "long" : "short",
    entryTime: fill.time,
    exitTime: null,
    position,
    preSize,
    prePx: null,
    entrySz: 0,
    entryNtl: 0,
    exitSz: 0,
    exitNtl: 0,
    realizedPnl: 0,
    fees: 0,
    funding: fundingFrom !== null && fill.time >= fundingFrom ? 0 : null,
    liquidated: false,
    twap: false,
    fills: 0,
    lastFillTime: fill.time,
  };
}

/** A partial trade's first closing fill: solve the unseen part's price
 * from the average entry implied by `closedPnl` (long: px − pnl/size,
 * short: px + pnl/size), and fold it into the entry. */
function priceUnseen(trade: Trade, px: number, closing: number, closedPnl: number): void {
  if (trade.prePx !== null || trade.preSize === 0n || closing <= 0) return;
  const average = trade.side === "long" ? px - closedPnl / closing : px + closedPnl / closing;
  const unseen = toNumber(trade.preSize);
  const prePx = (average * (unseen + trade.entrySz) - trade.entryNtl) / unseen;
  trade.prePx = prePx;
  trade.entrySz += unseen;
  trade.entryNtl += prePx * unseen;
}

export interface ApplyResult {
  /** Every trade opened, changed or closed by this batch. */
  touched: Trade[];
  /** Trades dropped because the fills around them were inconsistent. */
  dropped: Trade[];
  /** Fills skipped for lack of `startPosition`. */
  skipped: number;
}

/**
 * Continues reconstruction with `fills` (any order; spot fills ignored).
 * `open` holds each coin's open trade from earlier batches and is updated
 * in place. `fundingFrom`: funding is complete for trades opened at or
 * after it (their `funding` starts at 0); earlier ones get null.
 */
export function applyFills(
  address: string,
  open: Map<string, Trade>,
  fills: HlUserFill[],
  fundingFrom: number | null = null,
): ApplyResult {
  const touched = new Map<bigint, Trade>();
  const dropped: Trade[] = [];
  let skipped = 0;
  const byCoin = new Map<string, HlUserFill[]>();
  for (const fill of fills) {
    if (isOutOfScopeSpotFill(fill)) continue;
    const list = byCoin.get(fill.coin) ?? [];
    list.push(fill);
    byCoin.set(fill.coin, list);
  }

  for (const [coin, coinFills] of byCoin) {
    for (const fill of executionOrder(coinFills)) {
      if (fill.startPosition === undefined) {
        skipped += 1;
        continue;
      }
      const start = toScaled(fill.startPosition);
      const delta = signedSize(fill);
      const end = start + delta;
      if (delta === 0n) continue;
      const px = num(fill.px);
      const fee = num(fill.fee);
      const closedPnl = num(fill.closedPnl);
      let trade = open.get(coin);

      if (trade && trade.position !== start) {
        // A fill is missing between the trade's last fill and this one.
        if (sign(start) === sign(trade.position)) {
          trade.position = start;
        } else {
          open.delete(coin);
          touched.delete(trade.openTid);
          dropped.push(trade);
          trade = undefined;
        }
      }
      if (!trade) {
        // Flat before this fill: a new trade. Otherwise the position was
        // open before the history we hold: a partial trade.
        trade = newTrade(fill, start === 0n ? end : start, abs(start), fundingFrom);
        open.set(coin, trade);
      }

      touched.set(trade.openTid, trade);
      trade.fills += 1;
      trade.lastFillTime = fill.time;
      trade.realizedPnl += closedPnl;
      if (liquidates(fill, address)) trade.liquidated = true;
      if (fill.twapId != null) trade.twap = true;
      const size = toNumber(abs(delta));

      if (end !== 0n && sign(end) === sign(start)) {
        trade.fees += fee;
        trade.position = end;
        if (abs(end) > abs(start)) {
          trade.entrySz += size;
          trade.entryNtl += size * px;
        } else {
          priceUnseen(trade, px, size, closedPnl);
          trade.exitSz += size;
          trade.exitNtl += size * px;
        }
        continue;
      }
      if (start === 0n) {
        // The opening fill of a new trade.
        trade.fees += fee;
        trade.entrySz += size;
        trade.entryNtl += size * px;
        continue;
      }

      // Close, or flip: the part of this fill that reaches zero closes. A
      // flip's whole fee stays with the closing trade, as on CopyDog.
      const closing = toNumber(abs(start));
      priceUnseen(trade, px, closing, closedPnl);
      trade.fees += fee;
      trade.exitSz += closing;
      trade.exitNtl += closing * px;
      trade.position = 0n;
      trade.exitTime = fill.time;
      open.delete(coin);
      if (FORCED_CLOSE_DIRS.has(fill.dir)) {
        // Closed by the exchange, not the trader: CopyDog leaves it out.
        touched.delete(trade.openTid);
        dropped.push(trade);
      }
      if (end !== 0n) {
        const opened = newTrade(fill, end, 0n, fundingFrom);
        const rest = toNumber(abs(end));
        opened.entrySz = rest;
        opened.entryNtl = rest * px;
        opened.fills = 1;
        opened.twap = fill.twapId != null;
        open.set(coin, opened);
        touched.set(opened.openTid, opened);
      }
    }
  }
  return { touched: [...touched.values()], dropped, skipped };
}

/** One `userFunding` entry's payload. */
export interface FundingEvent {
  time: number;
  coin: string;
  /** USDC, signed: negative = paid. */
  usdc: number;
}

/**
 * Adds funding payments to the trade that held the coin at that time:
 * entry < time ≤ exit (open: no upper bound). Hyperliquid pays funding
 * hourly and reports older payments as daily sums stamped 00:00 UTC, so a
 * day in which a coin was closed and reopened is attributed to whichever
 * trade was open at midnight; that is the only approximation. Trades whose
 * `funding` is null (opened before funding was read) are left null.
 * Returns how many events found a trade.
 */
export function attributeFunding(trades: Iterable<Trade>, events: FundingEvent[]): number {
  const byCoin = new Map<string, Trade[]>();
  for (const trade of trades) {
    const list = byCoin.get(trade.coin) ?? [];
    list.push(trade);
    byCoin.set(trade.coin, list);
  }
  let matched = 0;
  for (const event of events) {
    const trade = byCoin
      .get(event.coin)
      ?.find((t) => t.entryTime < event.time && (t.exitTime === null || event.time <= t.exitTime));
    if (!trade) continue;
    matched += 1;
    if (trade.funding !== null) trade.funding += event.usdc;
  }
  return matched;
}

/** The API's view of a trade. Open trades' hold runs until `now`. */
export function toRoundTrip(trade: Trade, now: number): RoundTrip {
  const entry = entryPx(trade);
  const exit = exitPx(trade);
  const size = tradeSize(trade);
  return {
    id: trade.openTid.toString(),
    coin: trade.coin,
    side: trade.side,
    status: isClosed(trade) ? "closed" : "open",
    entryTime: new Date(trade.entryTime),
    exitTime: trade.exitTime === null ? null : new Date(trade.exitTime),
    entryPx: entry,
    exitPx: exit,
    size,
    notional: size * (entry + (exit ?? 0)),
    volume: size * entry,
    holdSeconds: holdSeconds(trade, now),
    realizedPnl: trade.realizedPnl,
    fees: trade.fees,
    funding: trade.funding,
    netPnl: netPnl(trade),
    liquidated: trade.liquidated,
    twap: trade.twap,
    fills: trade.fills,
    partial: isPartial(trade),
    entryApprox: isEntryApprox(trade),
  };
}

/** Complete reconstruction of one batch of history (tests, tracked addresses). */
export function reconstructTrades(address: string, fills: HlUserFill[], fundingFrom: number | null = null): Trade[] {
  const open = new Map<string, Trade>();
  const result = applyFills(address, open, fills, fundingFrom);
  return result.touched.sort((a, b) => a.entryTime - b.entryTime || Number(a.openTid - b.openTid));
}
