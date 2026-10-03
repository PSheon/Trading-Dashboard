import type { CopyExecutionAccount, CopyFollowerActivity } from '@trading-dashboard/shared/contracts';
export const activityAccount: CopyExecutionAccount = { id: 'account', strategyId: 9, network: 'testnet', state: 'ready', address: `0x${'22'.repeat(20)}`, issue: null, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' };
export const otherActivityAccount: CopyExecutionAccount = { ...activityAccount, id: 'other', strategyId: 10, address: `0x${'33'.repeat(20)}` };
export function activityPage(a = activityAccount): CopyFollowerActivity {
  const time = '2026-10-03T00:00:00Z', hash = `0x${'44'.repeat(32)}`;
  return { mode: 'actual', accountId: a.id, strategyId: a.strategyId, network: a.network, accountAddress: a.address!, token: 'USDC',
    items: [{ key: `${a.network}:${a.address}:1`, kind: 'fill', coin: 'BTC', time, attribution: 'execution', executionKey: 'execution', oid: '7', tid: '1', side: 'B', size: '0.01', price: '100', realizedPnl: '2', exchangeFee: '0.000000000000000001', builderFee: '0', tradingCashDelta: '2.000000000000000001' },
      { key: `${a.network}:${a.address}:${hash}:BTC:${Date.parse(time) - 1000}`, kind: 'funding', coin: 'BTC', time: new Date(Date.parse(time) - 1000).toISOString(), attribution: 'account', executionKey: null, hash, funding: '-0.37', tradingCashDelta: '-0.37' }],
    previousCursor: 'opaque_cursor', hasMore: true, quarantine: { blocked: false, reason: null }, coverage: { historicalCompleteness: 'unproven', scannedThrough: null, unresolvedWindows: null, issue: null, updatedAt: null } };
}
