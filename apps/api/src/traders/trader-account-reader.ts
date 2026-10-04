import type { OnModuleDestroy } from '@nestjs/common';
import { HyperliquidAllDexsAccountSource } from '../copy/live/live-account-ws-source.js';
import { address, LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { LIVE_DEX_NAME, MAX_LIVE_PERP_DEXES } from '../copy/live/live-market-resolver.js';
import { validateInfoResponse } from '../hyperliquid/response-validation.js';
import type { HlClearinghouseStateResponse } from '../hyperliquid/types.js';
function fail(): never { throw new LiveBoundaryError('trader_account_coverage_invalid'); }
/** Public reporting only. The official all-venue state snapshot avoids a
 * separate REST request per venue. Missing entries remain unknown. This is
 * never a dedicated-account admission or proof of an empty financial account. */
export class TraderAccountReader implements OnModuleDestroy {
  constructor(private readonly source: HyperliquidAllDexsAccountSource, private readonly now = Date.now, private readonly infoUrl?: string) {
    if (!(source instanceof HyperliquidAllDexsAccountSource)) fail();
  }
  async read(suppliedUser: string, suppliedDexes: readonly string[]): Promise<{ states: Map<string, HlClearinghouseStateResponse>; missingDexes: string[]; observedAt: number }> {
    const user = address(suppliedUser), dexes = [...suppliedDexes];
    if (this.infoUrl !== undefined && this.infoUrl !== `https://api.hyperliquid${this.source.network === 'testnet' ? '-testnet' : ''}.xyz/info`) fail();
    if (!dexes.length || dexes.length > MAX_LIVE_PERP_DEXES || dexes[0] !== '' || new Set(dexes).size !== dexes.length ||
      dexes.some(dex => typeof dex !== 'string' || dex !== '' && !LIVE_DEX_NAME.test(dex))) fail();
    const snapshot = await this.source.read(user, 5000), now = this.now();
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
  async onModuleDestroy(): Promise<void> { await this.source.close(); }
}
