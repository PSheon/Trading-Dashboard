import type { OnModuleDestroy } from '@nestjs/common';
import { HyperliquidAllDexsAccountSource } from '../copy/live/live-account-ws-source.js';
import { address, LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { MAX_LIVE_PERP_DEXES, LIVE_DEX_NAME } from '../copy/live/live-market-resolver.js';
import { validateInfoResponse } from '../hyperliquid/response-validation.js';
import type { HlFrontendOpenOrder } from '../hyperliquid/types.js';
import { PageBusyError } from '../hyperliquid/request-budgeter.service.js';

/** Public read-only orders. Official openOrders WS snapshots preserve frontend
 * order fields without one 20-weight REST request per venue. Every requested
 * venue and cleanup ACK is mandatory; financial admission uses other readers. */
export class TraderOrdersReader implements OnModuleDestroy {
  constructor(private readonly source: HyperliquidAllDexsAccountSource, private readonly now = Date.now, private readonly infoUrl?: string) {
    if (!(source instanceof HyperliquidAllDexsAccountSource)) throw new LiveBoundaryError('trader_orders_unavailable');
  }
  async read(accountAddress: string, suppliedDexes: readonly string[]): Promise<{ dexes: string[]; orders: HlFrontendOpenOrder[][]; observedAt: number }> {
    const user = address(accountAddress), dexes = [...suppliedDexes];
    if (this.infoUrl !== undefined && this.infoUrl !== `https://api.hyperliquid${this.source.network === 'testnet' ? '-testnet' : ''}.xyz/info`) throw new LiveBoundaryError('trader_orders_unavailable');
    if (!dexes.length || dexes.length > MAX_LIVE_PERP_DEXES || dexes[0] !== '' || new Set(dexes).size !== dexes.length ||
      dexes.some(dex => typeof dex !== 'string' || dex !== '' && !LIVE_DEX_NAME.test(dex))) throw new LiveBoundaryError('trader_orders_coverage_invalid');
    const result = await this.source.readOrders(user, dexes, 5000).catch(error => {
      if (error instanceof LiveBoundaryError && ['live_account_ws_message_budget', 'live_account_ws_connection_budget', 'live_account_orders_throttled', 'live_account_aggregate_unavailable'].includes(error.code)) throw new PageBusyError();
      throw error;
    });
    if (result.network !== this.source.network || result.accountAddress !== user || result.requestedDexes.length !== dexes.length ||
      result.requestedDexes.some((dex, i) => dex !== dexes[i]) || result.venues.length !== dexes.length ||
      result.venues.some((v, i) => v.dex !== dexes[i] || v.user !== user)) throw new LiveBoundaryError('trader_orders_coverage_invalid');
    const now = this.now(), oldest = Math.min(result.observedAt, ...result.venues.map(v => v.observedAt));
    if (![oldest, result.completedAt, now, ...result.venues.flatMap(v => [v.observedAt, v.receivedAt])].every(Number.isSafeInteger) ||
      oldest <= 0 || oldest > result.completedAt || result.completedAt > now || now - oldest > 5000 ||
      result.venues.some(v => v.observedAt < result.observedAt || v.receivedAt < v.observedAt || v.receivedAt > result.completedAt)) throw new LiveBoundaryError('trader_orders_stale');
    const orders = result.venues.map(v => {
      const rows = validateInfoResponse('frontendOpenOrders', v.orders) as HlFrontendOpenOrder[];
      if (rows.some(row => v.dex === '' ? row.coin.includes(':') : !row.coin.startsWith(`${v.dex}:`))) throw new LiveBoundaryError('trader_orders_coverage_invalid');
      return rows;
    });
    const identities = new Map<number, string>();
    for (const row of orders.flat()) {
      const original = identities.get(row.oid), captured = JSON.stringify(row);
      if (original !== undefined && original !== captured) throw new LiveBoundaryError('trader_orders_conflict');
      identities.set(row.oid, captured);
    }
    return { dexes, orders, observedAt: oldest };
  }
  async onModuleDestroy(): Promise<void> { await this.source.close(); }
}
