'use client';

import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import type { CopyExecutionAccount } from '@trading-dashboard/shared/contracts';

import { useCopyFollowerSnapshot } from '@/lib/copy-follower-snapshot';
import { useExecutionWallets } from '@/lib/copy-execution-wallets';
import { onOtherNetwork, useLiveCopyPortfolio, type LiveCopyItem } from '@/lib/copy-live-portfolio';

/**
 * The money in this network's real copies, one definition for 我的資金 and
 * the header's account pill (Stage, 2026-10-07: the pill said $0.00 while
 * 我的資金 said $79.00). Each copy's equity is its account snapshot, read by
 * a probe per copy (the same query the portfolio's cards read, so no extra
 * request while both are on screen); another network's copies and stopped
 * ones are left out.
 */
const reports = new Map<string, { id: number; equity: number | null }>();
const listeners = new Set<() => void>();
const empty = new Map<number, number | null>();
let published: ReadonlyMap<number, number | null> = empty;
function publish() {
  const byCopy = new Map<number, number | null>();
  for (const { id, equity } of reports.values()) byCopy.set(id, byCopy.get(id) === null ? null : equity);
  published = byCopy;
  listeners.forEach((listener) => listener());
}
function report(token: string, id: number, equity: number | null) {
  reports.set(token, { id, equity });
  publish();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** A total only when every counted copy has an observed balance. Unknown
 * balances remain unknown; only an unmounted probe leaves the collection. */
export function useCopiesEquity(): number | null {
  const portfolio = useLiveCopyPortfolio();
  const balances = useSyncExternalStore(subscribe, () => published, () => empty);
  if (!portfolio.data) return portfolio.enabled ? null : 0;
  let total = 0;
  for (const item of countedCopies(portfolio.data.items, portfolio.data.network)) {
    // A prior snapshot can still contain money already returning to the main
    // wallet. Wait for transfer reconciliation before combining both accounts.
    if (['funding', 'awaiting_credit', 'stopping', 'sweeping'].includes(item.stage)
      || (item.pendingTransfer && ['unknown', 'accepted'].includes(item.pendingTransfer.status))) return null;
    const equity = balances.get(item.strategyId);
    if (equity == null) return null;
    total += equity;
  }
  return total;
}

/** The copies counted in the total: this deployment's network, not stopped
 * or still being set up. */
export function countedCopies(items: readonly LiveCopyItem[], network: string | null | undefined): LiveCopyItem[] {
  return items.filter((item) => !onOtherNetwork(item, network) && item.stage !== 'stopped' && item.stage !== 'setup');
}

/** Reads each counted copy's equity into the total; renders nothing. */
export function CopyEquityProbes() {
  const portfolio = useLiveCopyPortfolio(), wallets = useExecutionWallets();
  const items = useMemo(() => countedCopies(portfolio.data?.items ?? [], portfolio.data?.network), [portfolio.data]);
  return <>{items.map((item) => <Probe key={item.strategyId} id={item.strategyId} account={wallets.data?.accounts.find((a) => a.id === item.accountId) ?? null} />)}</>;
}

function Probe({ id, account }: { id: number; account: CopyExecutionAccount | null }) {
  const token = useId();
  const snapshot = useCopyFollowerSnapshot(account);
  const equity = snapshot.data?.status === 'observed' ? Number(snapshot.data.metrics.perpEquity) : null;
  useEffect(() => {
    report(token, id, equity);
    return () => { reports.delete(token); publish(); };
  }, [token, id, equity]);
  return null;
}
