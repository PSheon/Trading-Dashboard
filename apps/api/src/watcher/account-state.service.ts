import { Inject, Injectable } from "@nestjs/common";
import { and, eq, like, sql } from "drizzle-orm";
import { CHAIN_DEFAULT, fills } from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { RequestPriority } from "../hyperliquid/request-budgeter.service.js";
import type { HlClearinghouseStateResponse } from "../hyperliquid/types.js";

/** Main dex key in `byDex`. */
export const MAIN_DEX = "";

export interface AccountState {
  fetchedAt: Date;
  /** One clearinghouseState per dex; `MAIN_DEX` plus every HIP-3 dex the
   * address has traded on. */
  byDex: Map<string, HlClearinghouseStateResponse>;
}

/** "xyz:TSLA" → "xyz"; "BTC" → MAIN_DEX. */
export function dexOf(coin: string): string {
  const i = coin.indexOf(":");
  return i === -1 ? MAIN_DEX : coin.slice(0, i);
}

/**
 * Latest positions and equity per address, across dexes.
 *
 * Each HIP-3 dex is a separate clearinghouse: `clearinghouseState` without
 * `dex` only shows main-dex positions. An address's HIP-3 dexes are learnt
 * from its stored fills (coins named "<dex>:<COIN>"), so a dex is queried
 * once the address has traded there.
 */
@Injectable()
export class AccountStateService {
  private readonly states = new Map<string, AccountState>();
  private readonly dexes = new Map<string, Set<string>>();

  constructor(
    private readonly info: HyperliquidInfoClient,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
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
      const rows = await this.db
        .selectDistinct({ dex: sql<string>`split_part(${fills.coin}, ':', 1)` })
        .from(fills)
        .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address), like(fills.coin, "%:%")));
      set = new Set(rows.map((r) => r.dex));
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
    const byDex = new Map<string, HlClearinghouseStateResponse>();
    await Promise.all(
      [...wanted].map(async (dex) => {
        byDex.set(dex, await this.info.clearinghouseState(address, dex || undefined, priority, rank));
      }),
    );
    const state = { fetchedAt: new Date(), byDex };
    this.states.set(address, state);
    return state;
  }

  get(address: string): AccountState | undefined {
    return this.states.get(address);
  }

  forget(address: string): void {
    this.states.delete(address);
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
