import type { LiveAccountSnapshot } from './live-account-observer.js';
import { copyFollowerSnapshotSchema, isHyperliquidNetwork, type CopyFollowerSnapshot, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { Dec } from '../../common/decimal/dec.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';

export interface FollowerViewIdentity { accountId: string; strategyId: number; network: HyperliquidNetwork; accountAddress: string }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function sameSet(a: readonly string[], b: readonly string[]): boolean { return a.length === new Set(a).size && b.length === new Set(b).size && a.length === b.length && a.every(v => b.includes(v)); }

/** Pure reporting projection. It never acquires evidence, changes account mode,
 * or turns a retained observation into financial admission authority. */
export function mapLiveAccountView(identity: FollowerViewIdentity, snapshot: LiveAccountSnapshot,
  quarantine: { blocked: boolean; reason: string | null }, nowMs: number, maxAgeMs: number): CopyFollowerSnapshot {
  try {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 5000 ||
      !isHyperliquidNetwork(identity.network) || snapshot.network !== identity.network || address(snapshot.accountAddress) !== address(identity.accountAddress)) throw new Error();
    const freshUntil = Math.min(snapshot.observedAt, snapshot.coverage.earliestProviderTime) + maxAgeMs;
    const view = copyFollowerSnapshotSchema.parse({ mode: 'actual', network: identity.network, accountId: identity.accountId, strategyId: identity.strategyId,
      accountAddress: address(identity.accountAddress), status: 'observed', freshness: nowMs <= freshUntil ? 'fresh' : 'stale', lastReadIssue: null,
      asOf: { observedAt: snapshot.observedAt, completedAt: snapshot.completedAt, earliestProviderTime: snapshot.coverage.earliestProviderTime, checkedAt: nowMs, freshUntil },
      sourceDigest: snapshot.sourceDigest, role: snapshot.role, accountMode: snapshot.accountMode, accountAbstraction: snapshot.accountAbstraction,
      collateral: { tokenIndex: snapshot.collateralToken, coin: snapshot.collateralCoin },
      metrics: { perpEquity: snapshot.perpEquity, marginUsed: snapshot.totalMarginUsed, withdrawable: snapshot.withdrawable, exposureUsd: snapshot.exposureUsd,
        restingExposureUsd: snapshot.restingExposureUsd, grossRestingExposureUsd: snapshot.grossRestingExposureUsd,
        unrealizedPnl: Dec.sum(snapshot.positions.map(p => Dec.from(p.unrealizedPnl))).toString(), roi: null, periodPnl: null, netDeposits: null },
      positions: snapshot.positions.map(p => ({ ...p })), restingOrders: snapshot.restingOrders.map(o => ({ ...o })), dexes: snapshot.dexes.map(d => ({ ...d })),
      coverage: { complete: snapshot.coverage.complete, balanceComplete: snapshot.coverage.balanceComplete, orderComplete: snapshot.coverage.orderComplete,
        listedDexes: [...snapshot.coverage.listedDexes], observedOrderDexes: [...snapshot.coverage.observedOrderDexes], unobservedOrderDexes: [...snapshot.coverage.unobservedOrderDexes] }, quarantine: { ...quarantine } });
    const { asOf } = view;
    if (asOf.observedAt > asOf.completedAt || asOf.completedAt > nowMs || asOf.completedAt > freshUntil ||
      !sameSet(view.coverage.listedDexes, view.dexes.map(d => d.dex)) || !sameSet(view.coverage.listedDexes, view.coverage.observedOrderDexes) ||
      new Set(view.dexes.map(d => d.perpDexIndex)).size !== view.dexes.length || Math.min(...view.dexes.map(d => d.providerTime)) !== asOf.earliestProviderTime) throw new Error();
    const sum = (values: readonly string[]) => Dec.sum(values.map(v => Dec.from(v)));
    for (const [metric, key] of [['perpEquity', 'equity'], ['marginUsed', 'marginUsed'], ['withdrawable', 'withdrawable'], ['exposureUsd', 'exposureUsd']] as const)
      if (!sum(view.dexes.map(d => d[key])).eq(view.metrics[metric])) throw new Error();
    if (!sum(view.restingOrders.map(o => o.notionalUsd)).eq(view.metrics.grossRestingExposureUsd) ||
      !sum(view.restingOrders.filter(o => !o.reduceOnly).map(o => o.notionalUsd)).eq(view.metrics.restingExposureUsd) ||
      new Set(view.restingOrders.map(o => o.oid)).size !== view.restingOrders.length || new Set(view.positions.map(p => p.asset)).size !== view.positions.length) throw new Error();
    for (const d of view.dexes) {
      const positions = view.positions.filter(p => p.dex === d.dex), orders = view.restingOrders.filter(o => o.dex === d.dex);
      const active = positions.length > 0 || orders.length > 0 || ['equity', 'rawUsd', 'marginUsed', 'withdrawable', 'exposureUsd', 'crossEquity', 'crossMarginUsed', 'crossExposureUsd', 'crossMaintenanceMarginUsed'].some(k => !Dec.from(d[k as keyof typeof d] as string).isZero);
      if (d.providerTime > asOf.completedAt || asOf.completedAt - d.providerTime > maxAgeMs || d.dex === '' && d.perpDexIndex !== 0 || d.dex !== '' && d.perpDexIndex === 0 ||
        active && (!d.supported || d.collateralCoin !== 'USDC' || d.collateralToken !== view.collateral.tokenIndex) ||
        !sum(positions.map(p => p.positionValue)).eq(d.exposureUsd) || !sum(positions.map(p => p.marginUsed)).eq(d.marginUsed) ||
        !sum(positions.filter(p => p.leverageType === 'cross').map(p => p.positionValue)).eq(d.crossExposureUsd) || !sum(positions.filter(p => p.leverageType === 'cross').map(p => p.marginUsed)).eq(d.crossMarginUsed)) throw new Error();
    }
    for (const item of [...view.positions, ...view.restingOrders]) {
      const d = view.dexes.find(d => d.dex === item.dex), base = d?.perpDexIndex ? 100000 + d.perpDexIndex * 10000 : 0;
      if (!d || !d.supported || !Number.isSafeInteger(base) || item.asset < base || item.asset >= base + 10000 ||
        (item.dex ? !item.coin.startsWith(`${item.dex}:`) : item.coin.includes(':'))) throw new Error();
    }
    for (const p of view.positions) if (p.leverage > p.maxLeverage || !Dec.from(p.size).eq(Dec.from(p.size).floor(p.sizeDecimals))) throw new Error();
    for (const o of view.restingOrders) if (o.timestamp > asOf.completedAt || !Dec.from(o.remainingSize).gt(0) || !Dec.from(o.limitPrice).gt(0) || Dec.from(o.remainingSize).gt(o.originalSize) || !Dec.from(o.remainingSize).mul(o.limitPrice).eq(o.notionalUsd)) throw new Error();
    return freeze(view);
  } catch { throw new LiveBoundaryError('follower_snapshot_invalid'); }
}
