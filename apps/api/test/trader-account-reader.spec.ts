import { describe, it, expect, vi } from 'vitest';
import { HyperliquidAllDexsAccountSource } from '../src/copy/live/live-account-ws-source.js';
import { TraderAccountReader } from '../src/traders/trader-account-reader.js';
const user = `0x${'11'.repeat(20)}`, now = Date.now();
const state = (coin?: string) => ({ assetPositions: coin ? [{ position: { coin, szi: '1', leverage: { type: 'cross', value: 1 }, entryPx: '10', marginUsed: '10', unrealizedPnl: '0' } }] : [],
  marginSummary: { accountValue: '10', totalNtlPos: '10', totalRawUsd: '10', totalMarginUsed: '0' },
  crossMarginSummary: { accountValue: '10', totalNtlPos: '10', totalRawUsd: '10', totalMarginUsed: '0' }, withdrawable: '10', time: now });
function fixture(rows: unknown[][] = [['', state()], ['xyz', state('xyz:INTC')]]) {
  const source = new HyperliquidAllDexsAccountSource(() => now, undefined, 'mainnet');
  const read = vi.spyOn(source, 'read').mockResolvedValue({ network: 'mainnet', accountAddress: user, observedAt: now,
    data: { user, clearinghouseStates: rows } });
  return { source, read, reader: new TraderAccountReader(source, () => now, 'https://api.hyperliquid.xyz/info') };
}
describe('public all-venue account snapshots', () => {
  it('retains exact venue/position identity and original provider time in one read', async () => {
    const f = fixture(), result = await f.reader.read(user, ['', 'xyz']);
    expect(result.states.get('xyz')!.assetPositions[0].position.coin).toBe('xyz:INTC'); expect(result.observedAt).toBe(now);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(user, 5000);
  });
  it('never invents a zero state for an omitted venue', async () => {
    const f = fixture([['', state()]]), result = await f.reader.read(user, ['', 'xyz']);
    expect(result.states.has('xyz')).toBe(false); expect(result.missingDexes).toEqual(['xyz']);
  });
  it.each(['duplicate', 'unlisted', 'wrongCoin', 'malformed', 'wrongUser', 'wrongNetwork', 'stale'] as const)('rejects contradictory snapshot evidence: %s', async kind => {
    const f = fixture();
    if (kind === 'duplicate') f.read.mockResolvedValueOnce({ network: 'mainnet', accountAddress: user, observedAt: now, data: { user, clearinghouseStates: [['', state()], ['', state()]] } });
    if (kind === 'unlisted') f.read.mockResolvedValueOnce({ network: 'mainnet', accountAddress: user, observedAt: now, data: { user, clearinghouseStates: [['', state()], ['foreign', state()]] } });
    if (kind === 'wrongCoin') f.read.mockResolvedValueOnce({ network: 'mainnet', accountAddress: user, observedAt: now, data: { user, clearinghouseStates: [['', state('xyz:INTC')], ['xyz', state()]] } });
    if (kind === 'malformed') f.read.mockResolvedValueOnce({ network: 'mainnet', accountAddress: user, observedAt: now, data: { user, clearinghouseStates: [['', { withdrawable: 'NaN' }]] } });
    if (kind === 'wrongUser') f.read.mockResolvedValueOnce({ network: 'mainnet', accountAddress: user, observedAt: now, data: { user: `0x${'22'.repeat(20)}`, clearinghouseStates: [['', state()]] } });
    if (kind === 'wrongNetwork') f.read.mockResolvedValueOnce({ network: 'testnet', accountAddress: user, observedAt: now, data: { user, clearinghouseStates: [['', state()]] } });
    if (kind === 'stale') f.read.mockResolvedValueOnce({ network: 'mainnet', accountAddress: user, observedAt: now - 5001, data: { user, clearinghouseStates: [['', state()]] } });
    await expect(f.reader.read(user, ['', 'xyz'])).rejects.toThrow();
  });
});
