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
 * Round-trip trades from fills, as CopyDog defines them (its 交易 / 表現
 * tabs; see docs/trade-analytics.md).
 *
 * A trade opens when a coin's position leaves 0 and closes when it returns
 * to 0 or flips (the part reaching zero closes, the rest opens the next
 * trade; fee and `closedPnl` stay with the closing leg, as Hyperliquid books
 * them). `startPosition` makes boundaries exact; same-millisecond fills are
 * chained by `executionOrder`.
 *
 * Per trade: size = Σ fills that grew the position; entry/exit price are
 * VWAPs of growing/shrinking fills; gross = Σ `closedPnl`; net = gross − Σ
 * `fee` (win: net > 0). Funding is separate (`attributeFunding`), not in net.
 *
 * History starting mid-position gives a *partial* trade: the unseen size is
 * the position before the first held fill, priced exactly from the first
 * closing fill's `closedPnl` (booked against average entry); until then
 * `entryApprox`.
 *
 * Exchange-forced closes (ADL, delisting settlement) are dropped, as on
 * CopyDog. A fill not starting where the trade stands (missing fill): a
 * same-side jump continues, anything else drops the trade.
 *
 * Incremental: `applyFills` continues from trades still open.
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

/** Exchange-forced closes; CopyDog counts no trade ending in one (checked
 * against 0xf62e… and 0xeadc… ledgers). */
const FORCED_CLOSE_DIRS = new Set(["Auto-Deleveraging", "Settlement"]);

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
function isEntryApprox(trade: Trade): boolean {
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
function tradeSize(trade: Trade): number {
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
 * Adds funding to the trade holding the coin then: entry < time ≤ exit.
 * Older payments arrive as daily sums at 00:00 UTC, so a day with a
 * close/reopen goes to the trade open at midnight (the only approximation).
 * Null `funding` stays null. Returns how many events found a trade.
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
