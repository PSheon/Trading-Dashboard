import { Injectable } from "@nestjs/common";

import { AccountStateRepository } from "./account-state.repository.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { RequestPriority } from "../hyperliquid/request-budgeter.service.js";
import type { HlClearinghouseStateResponse } from "../hyperliquid/types.js";
import { MAIN_DEX, PositionBook, dexOf, type BookTrade } from "./position-book.js";

export { MAIN_DEX, dexOf };

export interface AccountState {
  /** When the last full refresh (main + every known dex) finished. */
  fetchedAt: Date;
  /** One clearinghouseState per dex; `MAIN_DEX` plus every HIP-3 dex the
   * address has traded on. */
  byDex: Map<string, HlClearinghouseStateResponse>;
}

/**
 * Latest positions and equity per address, across dexes.
 *
 * Each HIP-3 dex is a separate clearinghouse: `clearinghouseState` without
 * `dex` only shows main-dex positions. An address's HIP-3 dexes are learnt
 * from its stored fills (coins named "<dex>:<COIN>"), so a dex is queried
 * once the address has traded there.
 *
 * Every state read is also installed into the address's `PositionBook`,
 * which the feed fast path keeps current trade by trade.
 */
@Injectable()
export class AccountStateService {
  private readonly states = new Map<string, AccountState>();
  private readonly dexes = new Map<string, Set<string>>();
  private readonly books = new Map<string, PositionBook>();

  constructor(
    private readonly info: HyperliquidInfoClient,
    private readonly repository: AccountStateRepository,
  ) {}

  /** Records dexes seen in freshly stored fills. */
  noteCoins(address: string, coins: Iterable<string>): void {
    const set = this.dexes.get(address);
    for (const coin of coins) {
      const dex = dexOf(coin);
      if (dex !== MAIN_DEX) set?.add(dex);
    }
  }

  /** HIP-3 dexes this address has fills on (loaded from the DB once). */
  async knownDexes(address: string): Promise<string[]> {
    let set = this.dexes.get(address);
    if (!set) {
      const dexes = await this.repository.knownDexes(address);
      set = new Set(dexes);
      this.dexes.set(address, set);
    }
    return [...set].sort();
  }

  /** Fetches main + the given (or all known) HIP-3 dexes and caches them. */
  async refresh(
    address: string,
    priority: RequestPriority,
    extraDexes: Iterable<string> = [],
    rank?: number,
  ): Promise<AccountState> {
    const wanted = new Set([MAIN_DEX, ...(await this.knownDexes(address)), ...extraDexes]);
    const byDex = await this.fetch(address, wanted, priority, rank);
    const state = { fetchedAt: new Date(), byDex };
    this.states.set(address, state);
    this.install(address, byDex);
    return state;
  }

  /** Fetches only `dexes` (the fast path: a book for a dex just traded on,
   * or the leverage of a position just opened) and merges them into the
   * cached state. `fetchedAt` stays that of the last full refresh. */
  async refreshDexes(address: string, dexes: Iterable<string>, priority: RequestPriority, rank?: number): Promise<void> {
    const fetched = await this.fetch(address, new Set(dexes), priority, rank);
    const previous = this.states.get(address);
    this.states.set(address, {
      fetchedAt: previous?.fetchedAt ?? new Date(),
      byDex: new Map([...(previous?.byDex ?? []), ...fetched]),
    });
    this.install(address, fetched);
  }

  private async fetch(
    address: string,
    dexes: Set<string>,
    priority: RequestPriority,
    rank?: number,
  ): Promise<Map<string, HlClearinghouseStateResponse>> {
    const byDex = new Map<string, HlClearinghouseStateResponse>();
    await Promise.all(
      [...dexes].map(async (dex) => {
        byDex.set(dex, await this.info.clearinghouseState(address, dex || undefined, priority, rank));
      }),
    );
    return byDex;
  }

  private install(address: string, byDex: Map<string, HlClearinghouseStateResponse>): void {
    const book = this.book(address);
    for (const [dex, state] of byDex) book.install(dex, state);
  }

  /** The address's position book (created empty: no dex installed). */
  book(address: string): PositionBook {
    let book = this.books.get(address);
    if (!book) {
      book = new PositionBook();
      this.books.set(address, book);
    }
    return book;
  }

  /** Adds processed feed trades to the address's book. */
  applyTrades(address: string, trades: Iterable<BookTrade>): void {
    this.book(address).apply(trades);
  }

  /** Drops position books (all, or these addresses'): after a feed gap
   * they may have missed trades, so the next burst reads state afresh. */
  dropBooks(addresses?: Iterable<string>): void {
    if (!addresses) this.books.clear();
    else for (const address of addresses) this.books.delete(address);
  }

  get(address: string): AccountState | undefined {
    return this.states.get(address);
  }

  forget(address: string): void {
    this.states.delete(address);
    this.books.delete(address);
  }

  /** Account value summed across dexes, or null before the first refresh. */
  getEquityUsd(address: string): number | null {
    const state = this.states.get(address);
    if (!state) return null;
    let total = 0;
    for (const response of state.byDex.values()) total += Number(response.marginSummary.accountValue);
    return total;
  }

  /** Current leverage of an open position, or null. */
  leverageFor(address: string, coin: string): number | null {
    const response = this.states.get(address)?.byDex.get(dexOf(coin));
    const position = response?.assetPositions.find((ap) => ap.position.coin === coin)?.position;
    return position && Number(position.szi) !== 0 ? (position.leverage?.value ?? null) : null;
  }

  /** Signed size per coin across dexes, flat positions omitted. */
  static positions(state: AccountState): Map<string, string> {
    const out = new Map<string, string>();
    for (const response of state.byDex.values()) {
      for (const { position } of response.assetPositions) {
        if (Number(position.szi) !== 0) out.set(position.coin, position.szi);
      }
    }
    return out;
  }
}
