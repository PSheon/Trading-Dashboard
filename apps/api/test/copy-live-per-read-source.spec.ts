import { describe, expect, it } from 'vitest';
import { PerReadAllDexsAccountSource, type LiveAllDexsAccountSource, type LiveAllDexsAccountEvidence } from '../src/copy/live/live-account-ws-source.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';

/** Like HyperliquidAllDexsAccountSource: one read at a time (`busy`). */
function oneAtATime(log: string[]): LiveAllDexsAccountSource {
  let busy = false;
  return {
    read: async () => { throw new Error('unused'); },
    readAccount: async (account: string) => {
      if (busy) throw new LiveBoundaryError('live_account_aggregate_unavailable');
      busy = true; await new Promise(resolve => setTimeout(resolve, 20)); busy = false; log.push(`read ${account}`);
      return { state: {}, orders: {} } as unknown as LiveAllDexsAccountEvidence;
    },
    close: () => { log.push('closed'); },
  };
}

// Stage 2026-10-06: an owner with three copies; the order's evidence epoch
// observes every live account at once, and one shared source refused all
// but the first (live_account_aggregate_unavailable, no order ever placed).
describe('account reads for an owner with several copies', () => {
  it('one shared source refuses concurrent reads (why the per-read source exists)', async () => {
    const shared = oneAtATime([]);
    const results = await Promise.allSettled(['0xa', '0xb', '0xc'].map(a => shared.readAccount!(a, [''], 5000)));
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(2);
  });
  it('the per-read source gives each read its own socket and closes it after', async () => {
    const log: string[] = [];
    const source = new PerReadAllDexsAccountSource(() => oneAtATime(log));
    const results = await Promise.allSettled(['0xa', '0xb', '0xc'].map(a => source.readAccount(a, [''], 5000)));
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    expect(log.filter(l => l === 'closed')).toHaveLength(3);
  });
  it('closes the socket when the read fails too', async () => {
    const log: string[] = [];
    const failing: LiveAllDexsAccountSource = { read: async () => { throw new Error('x'); }, readAccount: async () => { throw new LiveBoundaryError('live_account_orders_unavailable'); }, close: () => { log.push('closed'); } };
    await expect(new PerReadAllDexsAccountSource(() => failing).readAccount('0xa', [''], 5000)).rejects.toThrow('live_account_orders_unavailable');
    expect(log).toEqual(['closed']);
  });
});
