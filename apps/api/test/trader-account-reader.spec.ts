import { describe, it, expect, vi } from 'vitest';
import { HyperliquidAllDexsAccountSource } from '../src/copy/live/live-account-ws-source.js';
import { ACCOUNT_READ_QUEUE_MAX, ACCOUNT_READ_WAIT_MS, TraderAccountReader } from '../src/traders/trader-account-reader.js';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
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

class OfflineSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly send = vi.fn((_body: string) => {});
  readonly terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
}
/** One real source on an offline socket that answers every subscription a
 * little later with the subscribed user's own state, as Hyperliquid does. */
function socketSource(delayMs = 5) {
  const socket = new OfflineSocket();
  socket.send.mockImplementation((body) => {
    const request = JSON.parse(body);
    setTimeout(() => {
      socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
      if (request.method === 'subscribe') socket.emit('message', Buffer.from(JSON.stringify({ channel: 'allDexsClearinghouseState',
        data: { user: request.subscription.user, clearinghouseStates: [['', state(`${request.subscription.user.slice(2, 6).toUpperCase()}`)]] } })));
    }, delayMs);
  });
  const source = new HyperliquidAllDexsAccountSource(Date.now, () => socket as unknown as WebSocket, 'mainnet');
  return { socket, source, reader: new TraderAccountReader(source, Date.now, 'https://api.hyperliquid.xyz/info') };
}
const users = ['aa', 'bb', 'cc'].map(b => `0x${b.repeat(20)}`);

describe('concurrent cold profiles (audit A1)', () => {
  it('answers different addresses read at the same moment, each with its own perps', async () => {
    const s = socketSource(), read = vi.spyOn(s.source, 'read');
    try {
      const results = await Promise.allSettled(users.map(u => s.reader.read(u, [''])));
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      results.forEach((r, i) => {
        const coin = (r as PromiseFulfilledResult<Awaited<ReturnType<TraderAccountReader['read']>>>).value.states.get('')!.assetPositions[0].position.coin;
        expect(coin).toBe(users[i].slice(2, 6).toUpperCase());
      });
      // One exchange on the socket at a time: the source never refused a turn.
      expect(read).toHaveBeenCalledTimes(3);
      for (const call of read.mock.results) await expect(call.value).resolves.toBeDefined();
    } finally { await s.source.close(); }
  });
  it('gives up on a turn that does not come in time without calling the source, and the queue moves on', async () => {
    vi.useFakeTimers();
    try {
      const source = new HyperliquidAllDexsAccountSource(() => Date.now(), undefined, 'mainnet');
      let release!: () => void;
      const read = vi.spyOn(source, 'read')
        .mockImplementationOnce(async (user) => { await new Promise<void>(r => { release = r; }); return { network: 'mainnet', accountAddress: user, observedAt: Date.now(), data: { user, clearinghouseStates: [['', state()]] } }; })
        .mockImplementation(async (user) => ({ network: 'mainnet', accountAddress: user, observedAt: Date.now(), data: { user, clearinghouseStates: [['', state()]] } }));
      const reader = new TraderAccountReader(source, () => Date.now(), 'https://api.hyperliquid.xyz/info');
      const first = reader.read(users[0], ['']);
      const second = expect(reader.read(users[1], [''])).rejects.toThrow('trader_account_busy');
      await vi.advanceTimersByTimeAsync(ACCOUNT_READ_WAIT_MS + 1);
      await second;
      release(); await first;
      expect(read).toHaveBeenCalledTimes(1);
      await expect(reader.read(users[2], [''])).resolves.toBeDefined();
      expect(read).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('refuses at once beyond the queue bound', async () => {
    const source = new HyperliquidAllDexsAccountSource(Date.now, undefined, 'mainnet');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(source, 'read').mockImplementation(async (user) => { await gate; return { network: 'mainnet', accountAddress: user, observedAt: Date.now(), data: { user, clearinghouseStates: [['', state()]] } }; });
    const reader = new TraderAccountReader(source, Date.now, 'https://api.hyperliquid.xyz/info');
    const queued = Array.from({ length: ACCOUNT_READ_QUEUE_MAX }, () => reader.read(users[0], ['']));
    await expect(reader.read(users[1], [''])).rejects.toThrow('trader_account_busy');
    release(); await Promise.all(queued);
  });
});
