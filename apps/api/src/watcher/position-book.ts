import type { HlClearinghouseStateResponse } from "../hyperliquid/types.js";
import { toScaled } from "./action-classifier.js";

/** Main dex key. */
export const MAIN_DEX = "";

/** "xyz:TSLA" → "xyz"; "BTC" → MAIN_DEX. */
export function dexOf(coin: string): string {
  const i = coin.indexOf(":");
  return i === -1 ? MAIN_DEX : coin.slice(0, i);
}

/** How long an address's feed trades are kept for replaying onto a newly
 * installed state. States are fetched fresh (a request times out after
 * 20 s), so a state is never older than this. */
export const BOOK_BUFFER_MS = 2 * 60_000;

/** One feed trade from the book owner's side. */
export interface BookTrade {
  tid: bigint;
  coin: string;
  time: number;
  /** Signed size, scaled (`toScaled`): + when the owner bought. */
  signed: bigint;
}

interface DexBook {
  /** Signed size per coin, scaled; flat coins absent. */
  positions: Map<string, bigint>;
  /** The installed state's `time`: it includes every fill up to then
   * (checked live 2026-09-29). */
  asOf: number;
  /** Trades after `asOf` already added to `positions`. */
  applied: Set<bigint>;
}

/**
 * One address's positions, kept current between `clearinghouseState` reads
 * by adding each feed trade as it is processed.
 *
 * A state includes every fill up to its `time`, so installing one sets
 * the dex's positions and then replays the buffered trades that came after
 * it. A trade is added at most once, and never if the installed state
 * already includes it; so states and trades can arrive in any order.
 */
export class PositionBook {
  private readonly dexes = new Map<string, DexBook>();
  /** Recent trades by tid, for replaying onto the next installed state. */
  private readonly buffer = new Map<bigint, BookTrade>();

  has(dex: string): boolean {
    return this.dexes.has(dex);
  }

  asOf(dex: string): number | undefined {
    return this.dexes.get(dex)?.asOf;
  }

  /** Signed size (scaled), 0 when flat; undefined if the coin's dex has no
   * state installed. */
  position(coin: string): bigint | undefined {
    const book = this.dexes.get(dexOf(coin));
    return book ? (book.positions.get(coin) ?? 0n) : undefined;
  }

  /** Installs one dex's state. A state older than the installed one is
   * ignored (two refreshes can answer out of order). */
  install(dex: string, state: HlClearinghouseStateResponse, now = Date.now()): boolean {
    const current = this.dexes.get(dex);
    if (current && state.time < current.asOf) return false;
    this.prune(now);
    const positions = new Map<string, bigint>();
    for (const { position } of state.assetPositions) {
      const szi = toScaled(position.szi);
      if (szi !== 0n) positions.set(position.coin, szi);
    }
    const book: DexBook = { positions, asOf: state.time, applied: new Set() };
    this.dexes.set(dex, book);
    for (const trade of this.buffer.values()) {
      if (dexOf(trade.coin) === dex) this.add(book, trade);
    }
    return true;
  }

  /** True if the installed state, or an earlier `apply`, already counts
   * this trade. False if its dex has no state. */
  includes(trade: BookTrade): boolean {
    const book = this.dexes.get(dexOf(trade.coin));
    return !!book && (trade.time <= book.asOf || book.applied.has(trade.tid));
  }

  /** Adds trades (once each) and buffers them for the next install. */
  apply(trades: Iterable<BookTrade>, now = Date.now()): void {
    this.prune(now);
    for (const trade of trades) {
      if (!this.buffer.has(trade.tid)) this.buffer.set(trade.tid, trade);
      const book = this.dexes.get(dexOf(trade.coin));
      if (book) this.add(book, trade);
    }
  }

  /**
   * Position right before each of `trades` (tid → scaled size), given in
   * execution order: the book minus those of `trades` it already includes
   * gives the position before the first; each then starts where the
   * previous ended. Null if a coin's dex has no state.
   */
  startPositions(trades: BookTrade[]): Map<bigint, bigint> | null {
    const running = new Map<string, bigint>();
    for (const coin of new Set(trades.map((t) => t.coin))) {
      const position = this.position(coin);
      if (position === undefined) return null;
      running.set(coin, position);
    }
    for (const trade of trades) {
      if (this.includes(trade)) running.set(trade.coin, running.get(trade.coin)! - trade.signed);
    }
    const out = new Map<bigint, bigint>();
    for (const trade of trades) {
      const before = running.get(trade.coin)!;
      out.set(trade.tid, before);
      running.set(trade.coin, before + trade.signed);
    }
    return out;
  }

  private add(book: DexBook, trade: BookTrade): void {
    if (trade.time <= book.asOf || book.applied.has(trade.tid)) return;
    book.applied.add(trade.tid);
    const next = (book.positions.get(trade.coin) ?? 0n) + trade.signed;
    if (next === 0n) book.positions.delete(trade.coin);
    else book.positions.set(trade.coin, next);
  }

  private prune(now: number): void {
    const cutoff = now - BOOK_BUFFER_MS;
    for (const [tid, trade] of this.buffer) {
      if (trade.time >= cutoff) continue;
      this.buffer.delete(tid);
      for (const book of this.dexes.values()) book.applied.delete(tid);
    }
  }
}
