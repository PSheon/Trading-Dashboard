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
 * Round-trip trades from fills, for any address (CopyDog's 交易 tab).
 *
 * A trade opens when a coin's position leaves 0 and closes when it returns
 * to 0, or flips: a fill that takes a long through zero into a short closes
 * the long with the part of its size that reaches zero and opens the short
 * with the rest (its fee is split by size; its `closedPnl` all belongs to
 * the closing leg, which is where Hyperliquid books it). Adds and reduces
 * stay inside the trade. Every fill carries `startPosition`, the position
 * right before it, so the boundaries are exact; fills sharing a
 * millisecond are put in execution order by chaining those positions
 * (`executionOrder`, the same rule the action classifier uses).
 *
 * Per trade: volume-weighted entry price (every increasing fill) and exit
 * price (every decreasing fill), the largest position and its notional,
 * realized PnL = Σ `closedPnl` (Hyperliquid's own, before fees), fees = Σ
 * `fee`, net = realized − fees. Funding is added separately
 * (`attributeFunding`). TWAP slices are fills like any other.
 *
 * History that starts mid-position (the address's first fill we have for a
 * coin doesn't start from 0, because older fills are beyond Hyperliquid's
 * retention or our lookback) can't give that trade's entry: its fills are
 * skipped until the position next returns to 0 or flips. A fill that
 * doesn't start where the running trade stands (a fill missing from the
 * data) resyncs to it: a same-side jump just continues, anything else drops
 * the trade rather than guessing.
 *
 * Reconstruction is incremental: `applyFills` continues from the trades
 * still open after the previous batch, so a refresh only reads new fills.
 */
export type TradeSide = "long" | "short";

export interface Trade {
  coin: string;
  /** tid of the fill that opened it; unique per address. */
  openTid: bigint;
  side: TradeSide;
  entryTime: number;
  /** Null while open. */
  exitTime: number | null;
  /** Signed size now, scaled (`toScaled`); 0n once closed. */
  position: bigint;
  /** Largest |position|, scaled. */
  maxSize: bigint;
  maxNotional: number;
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

export function entryPx(trade: Trade): number {
  return trade.entrySz > 0 ? trade.entryNtl / trade.entrySz : 0;
}

export function exitPx(trade: Trade): number | null {
  return trade.exitSz > 0 ? trade.exitNtl / trade.exitSz : null;
}

export function netPnl(trade: Trade): number {
  return trade.realizedPnl - trade.fees;
}

/** Closed: exit − entry; open: `now` − entry. Seconds. */
export function holdSeconds(trade: Trade, now: number): number {
  return Math.max(0, ((trade.exitTime ?? now) - trade.entryTime) / 1000);
}

function openTrade(fill: HlUserFill, size: bigint, fee: number, address: string, fundingFrom: number | null): Trade {
  const px = num(fill.px);
  const sz = toNumber(abs(size));
  return {
    coin: fill.coin,
    openTid: BigInt(fill.tid),
    side: size > 0n ? "long" : "short",
    entryTime: fill.time,
    exitTime: null,
    position: size,
    maxSize: abs(size),
    maxNotional: sz * px,
    entrySz: sz,
    entryNtl: sz * px,
    exitSz: 0,
    exitNtl: 0,
    realizedPnl: 0,
    fees: fee,
    funding: fundingFrom !== null && fill.time >= fundingFrom ? 0 : null,
    liquidated: liquidates(fill, address),
    twap: fill.twapId != null,
    fills: 1,
    lastFillTime: fill.time,
  };
}

export interface ApplyResult {
  /** Every trade opened, changed or closed by this batch. */
  touched: Trade[];
  /** Trades dropped because the fills around them were inconsistent. */
  dropped: Trade[];
  /** Fills skipped: before a known open, or without `startPosition`. */
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
      const px = num(fill.px);
      const fee = num(fill.fee);
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
        if (start === 0n) {
          if (end !== 0n) {
            const opened = openTrade(fill, end, fee, address, fundingFrom);
            open.set(coin, opened);
            touched.set(opened.openTid, opened);
          }
        } else if (end !== 0n && sign(end) !== sign(start)) {
          // Flip out of a position whose entry we never saw: the new side's
          // trade starts here, with its share of the fee.
          const opened = openTrade(fill, end, (fee * toNumber(abs(end))) / toNumber(abs(delta)), address, fundingFrom);
          open.set(coin, opened);
          touched.set(opened.openTid, opened);
        } else {
          skipped += 1;
        }
        continue;
      }

      touched.set(trade.openTid, trade);
      trade.fills += 1;
      trade.lastFillTime = fill.time;
      trade.realizedPnl += num(fill.closedPnl);
      if (liquidates(fill, address)) trade.liquidated = true;
      if (fill.twapId != null) trade.twap = true;
      const size = toNumber(abs(delta));

      if (end !== 0n && sign(end) === sign(start)) {
        trade.fees += fee;
        trade.position = end;
        if (abs(end) > abs(start)) {
          trade.entrySz += size;
          trade.entryNtl += size * px;
          if (abs(end) > trade.maxSize) trade.maxSize = abs(end);
          trade.maxNotional = Math.max(trade.maxNotional, toNumber(abs(end)) * px);
        } else {
          trade.exitSz += size;
          trade.exitNtl += size * px;
        }
        continue;
      }

      // Close, or flip: the part of this fill that reaches zero closes.
      const closing = toNumber(abs(start));
      const closingFee = end === 0n ? fee : (fee * closing) / size;
      trade.fees += closingFee;
      trade.exitSz += closing;
      trade.exitNtl += closing * px;
      trade.position = 0n;
      trade.exitTime = fill.time;
      open.delete(coin);
      if (end !== 0n) {
        const opened = openTrade(fill, end, fee - closingFee, address, fundingFrom);
        // Liquidation closed the old side; the new side wasn't liquidated.
        opened.liquidated = false;
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
  return {
    id: trade.openTid.toString(),
    coin: trade.coin,
    side: trade.side,
    status: isClosed(trade) ? "closed" : "open",
    entryTime: new Date(trade.entryTime),
    exitTime: trade.exitTime === null ? null : new Date(trade.exitTime),
    entryPx: entryPx(trade),
    exitPx: exitPx(trade),
    maxSize: toNumber(trade.maxSize),
    maxNotional: trade.maxNotional,
    volume: trade.entryNtl + trade.exitNtl,
    holdSeconds: holdSeconds(trade, now),
    realizedPnl: trade.realizedPnl,
    fees: trade.fees,
    funding: trade.funding,
    netPnl: netPnl(trade),
    liquidated: trade.liquidated,
    twap: trade.twap,
    fills: trade.fills,
  };
}

/** Complete reconstruction of one batch of history (tests, tracked addresses). */
export function reconstructTrades(address: string, fills: HlUserFill[], fundingFrom: number | null = null): Trade[] {
  const open = new Map<string, Trade>();
  const result = applyFills(address, open, fills, fundingFrom);
  return result.touched.sort((a, b) => a.entryTime - b.entryTime || Number(a.openTid - b.openTid));
}
