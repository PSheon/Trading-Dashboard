import type { CopyFollowerSnapshot, CopyExecutionAccount } from '@trading-dashboard/shared/contracts';
import { activityAccount } from './copy-follower-activity-fixtures';
/** Public deterministic view fixture; not provider balance or admission proof. */
export function followerSnapshot(a: CopyExecutionAccount = activityAccount, now = Date.now()): CopyFollowerSnapshot {
  return { mode: 'actual', network: 'testnet', accountId: a.id, strategyId: a.strategyId, accountAddress: a.address!, status: 'observed', freshness: 'fresh', lastReadIssue: null,
    asOf: { observedAt: now, completedAt: now, earliestProviderTime: now, checkedAt: now, freshUntil: now + 5000 }, sourceDigest: 'a'.repeat(64), role: 'user', accountMode: 'standard', accountAbstraction: 'disabled', collateral: { tokenIndex: 7, coin: 'USDC' },
    metrics: { perpEquity: '100', marginUsed: '0', withdrawable: '100', exposureUsd: '0', restingExposureUsd: '0', grossRestingExposureUsd: '0', unrealizedPnl: '0', roi: null, periodPnl: null, netDeposits: null }, positions: [], restingOrders: [],
    dexes: [{ dex: '', perpDexIndex: 0, supported: true, collateralToken: 7, collateralCoin: 'USDC', providerTime: now, equity: '100', rawUsd: '100', marginUsed: '0', withdrawable: '100', exposureUsd: '0', crossEquity: '100', crossMarginUsed: '0', crossExposureUsd: '0', crossMaintenanceMarginUsed: '0' }],
    coverage: { complete: true, balanceComplete: true, orderComplete: true, listedDexes: [''], observedOrderDexes: [''], unobservedOrderDexes: [] }, quarantine: { blocked: false, reason: null } };
}
