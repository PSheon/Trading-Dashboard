import type { OnModuleDestroy } from '@nestjs/common';
import { HyperliquidAllDexsAccountSource } from '../copy/live/live-account-ws-source.js';
import { address, LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { LIVE_DEX_NAME, MAX_LIVE_PERP_DEXES } from '../copy/live/live-market-resolver.js';
import { validateInfoResponse } from '../hyperliquid/response-validation.js';
import type { HlClearinghouseStateResponse } from '../hyperliquid/types.js';
function fail(): never { throw new LiveBoundaryError('trader_account_coverage_invalid'); }
/** The source's own bound on one snapshot read. */
export const ACCOUNT_READ_TIMEOUT_MS = 5_000;
/** Longest a read waits for its turn on the socket. */
export const ACCOUNT_READ_WAIT_MS = 4_000;
/** Longest `read` takes in all, its turn included: what a caller racing it
 * must allow (a shorter race gave up on reads that were about to answer). */
export const ACCOUNT_READ_DEADLINE_MS = ACCOUNT_READ_WAIT_MS + ACCOUNT_READ_TIMEOUT_MS;
/** Reads that may wait for their turn at once; beyond this one fails at once. */
export const ACCOUNT_READ_QUEUE_MAX = 16;
/** Public reporting only. The official all-venue state snapshot avoids a
 * separate REST request per venue. Missing entries remain unknown. This is
 * never a dedicated-account admission or proof of an empty financial account.
 *
 * The source is one socket that holds one subscription exchange at a time
 * and refuses a second at once (`live_account_aggregate_unavailable`). Two
 * visitors opening different trader pages together used to get one profile
 * without perps (audit A1); reads now take turns, each waiting at most
 * `ACCOUNT_READ_WAIT_MS` (a warm read takes a few hundred ms). */
export class TraderAccountReader implements OnModuleDestroy {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  constructor(private readonly source: HyperliquidAllDexsAccountSource, private readonly now = Date.now, private readonly infoUrl?: string) {
    if (!(source instanceof HyperliquidAllDexsAccountSource)) fail();
  }
  async read(suppliedUser: string, suppliedDexes: readonly string[]): Promise<{ states: Map<string, HlClearinghouseStateResponse>; missingDexes: string[]; observedAt: number }> {
    const user = address(suppliedUser), dexes = [...suppliedDexes];
    if (this.infoUrl !== undefined && this.infoUrl !== `https://api.hyperliquid${this.source.network === 'testnet' ? '-testnet' : ''}.xyz/info`) fail();
    if (!dexes.length || dexes.length > MAX_LIVE_PERP_DEXES || dexes[0] !== '' || new Set(dexes).size !== dexes.length ||
      dexes.some(dex => typeof dex !== 'string' || dex !== '' && !LIVE_DEX_NAME.test(dex))) fail();
    const snapshot = await this.turn(() => this.source.read(user, ACCOUNT_READ_TIMEOUT_MS)), now = this.now();
    if (snapshot.network !== this.source.network || snapshot.accountAddress !== user || !Number.isSafeInteger(snapshot.observedAt) ||
      snapshot.observedAt <= 0 || !Number.isSafeInteger(now) || now < snapshot.observedAt || now - snapshot.observedAt > 5000) fail();
    const data = snapshot.data as { user?: unknown; clearinghouseStates?: unknown };
    if (!data || data.user !== user || !Array.isArray(data.clearinghouseStates) || data.clearinghouseStates.length > MAX_LIVE_PERP_DEXES) fail();
    const states = new Map<string, HlClearinghouseStateResponse>();
    for (const entry of data.clearinghouseStates) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !dexes.includes(entry[0]) || states.has(entry[0])) fail();
      const state = validateInfoResponse('clearinghouseState', entry[1]) as HlClearinghouseStateResponse;
      if (state.assetPositions.some(row => entry[0] === '' ? row.position.coin.includes(':') : !row.position.coin.startsWith(`${entry[0]}:`))) fail();
      states.set(entry[0], state);
    }
    return { states, missingDexes: dexes.filter(dex => !states.has(dex)), observedAt: snapshot.observedAt };
  }
  /** Runs `work` once every earlier read has finished; fails with
   * `trader_account_busy` when the queue is full or the turn does not come
   * within `ACCOUNT_READ_WAIT_MS` (the source is then never called). */
  private turn<T>(work: () => Promise<T>): Promise<T> {
    if (this.waiting >= ACCOUNT_READ_QUEUE_MAX) return Promise.reject(new LiveBoundaryError('trader_account_busy'));
    this.waiting++;
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
    const previous = this.tail;
    const result = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new LiveBoundaryError('trader_account_busy')); }, ACCOUNT_READ_WAIT_MS);
      void previous.then(async () => {
        clearTimeout(timer); this.waiting--;
        if (expired) return;
        try { resolve(await work()); } catch (error) { reject(error); }
      });
    });
    this.tail = previous.then(() => result.then(() => {}, () => {}));
    return result;
  }
  async onModuleDestroy(): Promise<void> { await this.source.close(); }
}
