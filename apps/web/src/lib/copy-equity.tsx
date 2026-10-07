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
const reports = new Map<string, { id: number; equity: number }>();
const listeners = new Set<() => void>();
let total = 0;
function publish() {
  const byCopy = new Map<number, number>();
  for (const { id, equity } of reports.values()) byCopy.set(id, equity);
  total = [...byCopy.values()].reduce((sum, value) => sum + value, 0);
  listeners.forEach((listener) => listener());
}
function report(token: string, id: number, equity: number | null) {
  if (equity === null) reports.delete(token); else reports.set(token, { id, equity });
  publish();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The equity of this network's running copies, as the probes last read it. */
export function useCopiesEquity(): number {
  return useSyncExternalStore(subscribe, () => total, () => 0);
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
    return () => report(token, id, null);
  }, [token, id, equity]);
  return null;
}
