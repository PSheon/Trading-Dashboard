'use client';
import { API_FIXTURES } from './config';
import { useLayoutEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { copyFollowerSnapshotReadSchema, isHyperliquidNetwork, type CopyExecutionAccount, type CopyFollowerSnapshotRead } from '@trading-dashboard/shared/contracts';
import type { FollowerStatementDependencies } from './copy-follower-statements';
import { api, sessionKey } from './api';
import { useAuth } from './auth';
import { queryKeys } from './query-keys';
/** The owner's session: Privy, or the fixture login in a fixture build (the portfolio demo). */
const ownerMode = (mode: string) => mode === 'privy' || (API_FIXTURES && mode === 'fixture');
function identity(a: CopyExecutionAccount) { return [a.id, a.strategyId, a.network, a.address?.toLowerCase() ?? null] as const; }
function units(v: string) { const negative = v.startsWith('-'), [whole, fraction = ''] = (negative ? v.slice(1) : v).split('.'); return BigInt(whole + fraction.padEnd(18, '0')) * (negative ? BigInt(-1) : BigInt(1)); }
function sum(v: readonly string[]) { return v.reduce((n, value) => n + units(value), BigInt(0)); }
function sameSet(a: readonly string[], b: readonly string[]) { return new Set(a).size === a.length && new Set(b).size === b.length && a.length === b.length && a.every(v => b.includes(v)); }
export function parseCopyFollowerSnapshot(value: unknown, account: CopyExecutionAccount): CopyFollowerSnapshotRead {
  const view = copyFollowerSnapshotReadSchema.parse(value);
  if (!isHyperliquidNetwork(account.network) || view.network !== account.network || !/^0x[0-9a-fA-F]{40}$/.test(account.address ?? '') || view.accountId !== account.id || view.strategyId !== account.strategyId || view.accountAddress !== account.address?.toLowerCase()) throw new Error('follower_snapshot_account_changed');
  if (view.status === 'unavailable') return view;
  const { asOf } = view, oldest = Math.min(asOf.observedAt, asOf.earliestProviderTime);
  if (Object.values(asOf).some(v => !Number.isFinite(new Date(v).getTime())) || asOf.observedAt > asOf.completedAt || asOf.completedAt > asOf.checkedAt || asOf.completedAt > asOf.freshUntil || asOf.freshUntil - oldest < 1 || asOf.freshUntil - oldest > 5000 ||
    view.freshness === 'fresh' && asOf.checkedAt > asOf.freshUntil || !sameSet(view.coverage.listedDexes, view.dexes.map(d => d.dex)) || !sameSet(view.coverage.listedDexes, view.coverage.observedOrderDexes) ||
    Math.min(...view.dexes.map(d => d.providerTime)) !== asOf.earliestProviderTime || new Set(view.dexes.map(d => d.perpDexIndex)).size !== view.dexes.length) throw new Error('follower_snapshot_evidence_invalid');
  for (const [metric, key] of [['perpEquity', 'equity'], ['marginUsed', 'marginUsed'], ['withdrawable', 'withdrawable'], ['exposureUsd', 'exposureUsd']] as const)
    if (sum(view.dexes.map(d => d[key])) !== units(view.metrics[metric])) throw new Error('follower_snapshot_totals_invalid');
  if (sum(view.positions.map(p => p.unrealizedPnl)) !== units(view.metrics.unrealizedPnl) || sum(view.restingOrders.map(o => o.notionalUsd)) !== units(view.metrics.grossRestingExposureUsd) ||
    sum(view.restingOrders.filter(o => !o.reduceOnly).map(o => o.notionalUsd)) !== units(view.metrics.restingExposureUsd)) throw new Error('follower_snapshot_totals_invalid');
  for (const d of view.dexes) {
    const positions = view.positions.filter(p => p.dex === d.dex), orders = view.restingOrders.filter(o => o.dex === d.dex);
    const active = positions.length > 0 || orders.length > 0 || [d.equity, d.rawUsd, d.marginUsed, d.withdrawable, d.exposureUsd, d.crossEquity, d.crossMarginUsed, d.crossExposureUsd, d.crossMaintenanceMarginUsed].some(v => units(v) !== BigInt(0));
    if (d.providerTime > asOf.completedAt || asOf.completedAt - d.providerTime > 5000 || active && (!d.supported || d.collateralCoin !== 'USDC' || d.collateralToken !== view.collateral.tokenIndex) ||
      sum(positions.map(p => p.positionValue)) !== units(d.exposureUsd) || sum(positions.map(p => p.marginUsed)) !== units(d.marginUsed)) throw new Error('follower_snapshot_evidence_invalid');
  }
  for (const item of [...view.positions, ...view.restingOrders]) {
    const d = view.dexes.find(d => d.dex === item.dex), base = d?.perpDexIndex ? 100000 + d.perpDexIndex * 10000 : 0;
    if (!d || !d.supported || item.asset < base || item.asset >= base + 10000 || (item.dex ? !item.coin.startsWith(`${item.dex}:`) : item.coin.includes(':'))) throw new Error('follower_snapshot_evidence_invalid');
  }
  return view;
}
export async function loadCopyFollowerSnapshot(account: CopyExecutionAccount, deps: FollowerStatementDependencies): Promise<CopyFollowerSnapshotRead> {
  const selected = { ...account }, owner = { ...deps.snapshot() };
  if (owner.status !== 'signedIn' || !ownerMode(owner.mode) || !owner.identity) throw new Error('follower_snapshot_owner_unavailable');
  if (!isHyperliquidNetwork(selected.network)) throw new Error('follower_snapshot_network_unsupported');
  if (!/^0x[0-9a-fA-F]{40}$/.test(selected.address ?? '')) throw new Error('follower_snapshot_account_unavailable');
  const guard = () => {
    deps.signal?.throwIfAborted(); const currentOwner = deps.snapshot(), current = deps.currentAccount();
    if (Object.keys(owner).some(k => owner[k as keyof typeof owner] !== currentOwner[k as keyof typeof owner])) throw new Error('follower_snapshot_session_changed');
    if (!current || identity(selected).some((v, i) => v !== identity(current)[i])) throw new Error('follower_snapshot_account_changed');
  };
  guard(); const result = await deps.read(`/me/copy/execution-wallets/${encodeURIComponent(selected.id)}/snapshot`, deps.signal); guard(); return parseCopyFollowerSnapshot(result, selected);
}
export function useCopyFollowerSnapshot(account: CopyExecutionAccount | null) {
  const auth = useAuth(), latest = useRef({ auth, account }), mounted = useRef(true);
  useLayoutEffect(() => { latest.current = { auth, account }; }, [auth, account]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const enabled = auth.status === 'signedIn' && ownerMode(auth.mode) && Boolean(auth.identity) && isHyperliquidNetwork(account?.network) && Boolean(account?.address);
  const query = useQuery({ queryKey: [...queryKeys.copy.all, 'follower-snapshot', auth.status, auth.mode, auth.identity, sessionKey(), auth.wallet?.address?.toLowerCase() ?? null, ...(account ? identity(account) : [null])], enabled,
    queryFn: async ({ signal }) => {
      const startedWall = Date.now(), startedMono = performance.now();
      if (!account) throw new Error('follower_snapshot_account_unavailable');
      const view = await loadCopyFollowerSnapshot(account, { signal, currentAccount: () => latest.current.account, read: (path, abort) => api.get(path, abort), snapshot: () => {
        const a = latest.current.auth; return { status: mounted.current ? a.status : 'disposed', mode: a.mode, identity: a.identity, session: sessionKey(), walletAddress: a.wallet?.address?.toLowerCase() ?? null };
      } });
      const receivedWall = Date.now(), receivedMono = performance.now();
      return { view, timing: { receivedWall, receivedMono, requestDuration: Math.max(0, receivedWall - startedWall, receivedMono - startedMono) } };
    }, retry: false, staleTime: 0, gcTime: 0, refetchInterval: 30000, refetchIntervalInBackground: false });
  return { ...query, data: enabled && !query.isError ? query.data?.view : undefined, timing: enabled && !query.isError ? query.data?.timing : undefined };
}
