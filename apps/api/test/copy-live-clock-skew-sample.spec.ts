import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockSkewMonitor, clockSkew } from '../src/copy/live/clock-skew.js';
import { HyperliquidAllDexsAccountSource } from '../src/copy/live/live-account-ws-source.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';

/**
 * Clock samples are taken where a socket frame arrives, never after the
 * read's other waits (2026-10-13 08:22: "our clock runs ahead of
 * Hyperliquid by about 3748 ms" with the host in sync to 0.1 s; each sample
 * was our clock once the whole observation was validated, its order batches
 * and meter queue included, minus the state's provider time).
 */
const account = `0x${'22'.repeat(20)}`, now = 1_790_000_000_000;
afterEach(() => { vi.restoreAllMocks(); });
const state = (time: number) => ({ marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
  crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0',
  withdrawable: '0', time, assetPositions: [] });
class OfflineSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly send = vi.fn((_body: string) => {});
  readonly terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
}

describe('clock skew sampled at the socket frame, not after the read', () => {
  it('a state frame that arrives 40 ms after its provider time is a 40 ms sample, however long the order batches take after it', async () => {
    let clock = now;
    const socket = new OfflineSocket(), monitor = new ClockSkewMonitor(60_000, () => undefined);
    socket.send.mockImplementation(body => {
      const request = JSON.parse(body);
      queueMicrotask(() => {
        socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
        if (request.method !== 'subscribe') return;
        if (request.subscription.type === 'allDexsClearinghouseState') {
          clock = now + 40; // the frame arrives 40 ms after Hyperliquid stamped it
          socket.emit('message', Buffer.from(JSON.stringify({ channel: 'allDexsClearinghouseState',
            data: { user: account, clearinghouseStates: [['', state(now)], ['dex1', state(now - 10)]] } })));
        } else {
          clock += 1_500; // each venue's orders come later: the read completes seconds after the frame
          socket.emit('message', Buffer.from(JSON.stringify({ channel: 'openOrders', data: { user: account, dex: request.subscription.dex, orders: [] } })));
        }
      });
    });
    const source = new HyperliquidAllDexsAccountSource(() => clock, () => socket as unknown as WebSocket, 'testnet', undefined, { clock: monitor });
    const proof = await source.readAccount(account, ['', 'dex1'], 5000);
    expect(proof.orders.completedAt).toBeGreaterThanOrEqual(now + 3_000);
    // One sample per state frame: its arrival minus the latest provider time in it.
    expect(monitor.status()).toEqual({ aheadMs: 40, samples: 1, warning: false });
    await source.close();
  });

  it('the account observer no longer samples once its observation is validated', async () => {
    const observe = vi.spyOn(clockSkew, 'observe');
    let clock = now;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const answers: Record<string, unknown> = { userRole: { role: 'user' }, userAbstraction: 'disabled', userDexAbstraction: false,
        spotClearinghouseState: { portfolioMarginEnabled: false, balances: [] }, spotMeta: { tokens: [{ index: 0, name: 'USDC', isCanonical: true }] },
        perpDexs: [null], allPerpMetas: [{ collateralToken: 0, universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }] };
      if (!(body.type in answers)) throw new Error(`unexpected ${body.type}`);
      return new Response(JSON.stringify(answers[body.type]));
    });
    const observer = new HyperliquidLiveAccountObserver('testnet', async () => {}, fetcher, () => clock, 5000, {
      read: async user => { const observedAt = clock; clock += 3_500; return { network: 'testnet', accountAddress: user, observedAt, data: { user, clearinghouseStates: [['', state(now)]] } }; },
      readOrders: async (user, dexes) => ({ network: 'testnet', accountAddress: user, observedAt: now, completedAt: now, requestedDexes: [...dexes],
        venues: dexes.map(dex => ({ dex, user, observedAt: now, receivedAt: now, orders: [] })) }),
    });
    await observer.observe(account);
    // Before: a 3.5 s "ahead" sample (validated after the read's waits).
    expect(observe).not.toHaveBeenCalled();
  });
});
