import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { HyperliquidAllDexsAccountSource } from '../src/copy/live/live-account-ws-source.js';
import { TraderOrdersReader } from '../src/traders/trader-orders-reader.js';

const user = `0x${'12'.repeat(20)}`, now = 1791060000000;
const order = { coin: 'xyz:TSLA', side: 'A', limitPx: '400', sz: '0', oid: 1, timestamp: now,
  origSz: '5', isTrigger: true, isPositionTpsl: true, reduceOnly: true, triggerCondition: 'Price below 390', triggerPx: '390', orderType: 'Stop Market' };
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn((_body: string) => {});
  terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
}
function setup(change?: (request: any, payload: any) => void) {
  const socket = new Socket(), factory = vi.fn((_url: string, _options: WebSocket.ClientOptions) => socket as unknown as WebSocket);
  let clock = now;
  socket.send.mockImplementation(body => {
    const request = JSON.parse(body);
    queueMicrotask(() => {
      socket.emit('message', Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: request })));
      if (request.method === 'subscribe') {
        const payload = { channel: 'openOrders', data: { user, dex: request.subscription.dex, orders: request.subscription.dex === 'xyz' ? [{ ...order }] : [] } };
        change?.(request, payload);
        socket.emit('message', Buffer.from(JSON.stringify(payload)));
      }
    });
  });
  const source = new HyperliquidAllDexsAccountSource(() => clock, factory, 'mainnet');
  return { reader: new TraderOrdersReader(source, () => clock), socket, factory, clock: (value: number) => { clock = value; } };
}
describe('full public trader order snapshot', () => {
  it('reads all 268 venues on the fixed mainnet socket without losing TP/SL fields', async () => {
    const s = setup(), dexes = ['', 'xyz', ...Array.from({ length: 266 }, (_, i) => `dex${i}`)];
    try {
      const result = await s.reader.read(user, dexes);
      expect(result.dexes).toEqual(dexes); expect(result.orders.flat()).toEqual([order]); expect(result.observedAt).toBe(now);
      expect(s.factory.mock.calls[0]![0]).toBe('wss://api.hyperliquid.xyz/ws');
      expect(s.socket.send).toHaveBeenCalledTimes(536);
    } finally { s.reader.onModuleDestroy(); }
  });
  it.each(['foreign user', 'wrong dex', 'malformed order', 'foreign coin'] as const)('refuses %s instead of returning partial orders', async kind => {
    const s = setup((_request, p) => {
      if (kind === 'foreign user') p.data.user = `0x${'34'.repeat(20)}`;
      if (kind === 'wrong dex') p.data.dex = 'unrequested';
      if (kind === 'malformed order' && p.data.dex === 'xyz') p.data.orders[0].side = 'OTHER';
      if (kind === 'foreign coin' && p.data.dex === 'xyz') p.data.orders[0].coin = 'other:TSLA';
    });
    try { await expect(s.reader.read(user, ['', 'xyz'])).rejects.toThrow(); }
    finally { s.reader.onModuleDestroy(); }
  });
  it('retains the original oldest venue time and refuses expired completion', async () => {
    let s: ReturnType<typeof setup>;
    s = setup(() => s.clock(now + 5001));
    try { await expect(s.reader.read(user, ['', 'xyz'])).rejects.toThrow('trader_orders_stale'); }
    finally { s.reader.onModuleDestroy(); }
  });
  it('never accepts a truncated or duplicated venue list', async () => {
    const s = setup();
    try { await expect(s.reader.read(user, ['xyz'])).rejects.toThrow(); await expect(s.reader.read(user, ['', 'xyz', 'xyz'])).rejects.toThrow(); }
    finally { s.reader.onModuleDestroy(); }
    expect(s.factory).not.toHaveBeenCalled();
  });
});
