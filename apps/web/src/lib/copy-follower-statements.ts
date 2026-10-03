"use client";

import { useLayoutEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { copyFollowerStatementSchema, type CopyExecutionAccount, type CopyFollowerStatement } from '@trading-dashboard/shared/contracts';
import { api, sessionKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { queryKeys } from '@/lib/query-keys';

export interface FollowerStatementOwner {
  status: string; mode: string; identity: string | null; session: string; walletAddress: string | null;
}
export interface FollowerStatementDependencies {
  snapshot(): FollowerStatementOwner;
  currentAccount(): CopyExecutionAccount | null;
  read(path: string, signal?: AbortSignal): Promise<unknown>;
  signal?: AbortSignal;
}
function amountUnits(value: string): bigint {
  if (value.length > 100 || !/^-?\d+(?:\.\d{1,18})?$/.test(value)) throw new Error('follower_statement_amount_invalid');
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return BigInt(whole + fraction.padEnd(18, '0')) * BigInt(negative ? -1 : 1);
}
function accountIdentity(account: CopyExecutionAccount) {
  return [account.id, account.strategyId, account.network, account.address?.toLowerCase() ?? null] as const;
}
export function parseCopyFollowerStatement(value: unknown, account: CopyExecutionAccount): CopyFollowerStatement {
  const result = copyFollowerStatementSchema.parse(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(account.address ?? '') || result.accountId !== account.id || result.strategyId !== account.strategyId || result.network !== account.network || result.accountAddress.toLowerCase() !== account.address?.toLowerCase()) throw new Error('follower_statement_account_changed');
  const actual = result.actual;
  if (amountUnits(actual.realizedPnl) + amountUnits(actual.exchangeFee) + amountUnits(actual.builderFee) + amountUnits(actual.funding) !== amountUnits(actual.tradingCashDelta)) throw new Error('follower_statement_totals_invalid');
  const keys = new Set<string>();
  for (const receipt of result.latestReceipts) {
    if (!receipt.key || !receipt.coin || keys.has(receipt.key) || (receipt.attribution === 'execution' ? !receipt.executionKey : receipt.executionKey !== null)) throw new Error('follower_statement_receipts_invalid');
    keys.add(receipt.key);
  }
  if (result.receiptCount.length > 100 || BigInt(result.receiptCount) < BigInt(keys.size)) throw new Error('follower_statement_receipts_invalid');
  return result;
}
/** Signed amounts stay decimal strings: tiny rebates and values above Number's precision survive. */
export function formatFollowerAmount(value: string): string {
  const units = amountUnits(value), negative = units < BigInt(0);
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const digits = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const tail = fraction.replace(/0+$/, '');
  return `${units === BigInt(0) ? '' : negative ? '-' : '+'}${digits}${tail ? `.${tail}` : ''} USDC`;
}
export async function loadCopyFollowerStatement(account: CopyExecutionAccount, deps: FollowerStatementDependencies): Promise<CopyFollowerStatement> {
  const selected = { ...account }, owner = { ...deps.snapshot() };
  if (owner.status !== 'signedIn' || owner.mode !== 'privy' || !owner.identity) throw new Error('follower_statement_owner_unavailable');
  if (!/^0x[0-9a-fA-F]{40}$/.test(selected.address ?? '')) throw new Error('follower_statement_account_unavailable');
  const guard = () => {
    deps.signal?.throwIfAborted();
    const currentOwner = deps.snapshot();
    if (Object.keys(owner).some((key) => owner[key as keyof FollowerStatementOwner] !== currentOwner[key as keyof FollowerStatementOwner])) throw new Error('follower_statement_session_changed');
    const current = deps.currentAccount();
    if (!current || accountIdentity(selected).some((value, index) => value !== accountIdentity(current)[index])) throw new Error('follower_statement_account_changed');
  };
  guard();
  const value = await deps.read(`/me/copy/execution-wallets/${encodeURIComponent(selected.id)}/statement`, deps.signal);
  guard(); return parseCopyFollowerStatement(value, selected);
}

export function useCopyFollowerStatement(account: CopyExecutionAccount | null) {
  const auth = useAuth(), latest = useRef({ auth, account }), mounted = useRef(true);
  useLayoutEffect(() => { latest.current = { auth, account }; }, [auth, account]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const wallet = auth.wallet?.address?.toLowerCase() ?? null;
  const query = useQuery({
    queryKey: [...queryKeys.copy.all, 'follower-statement', auth.status, auth.mode, auth.identity, sessionKey(), wallet, ...(account ? accountIdentity(account) : [null])],
    enabled: auth.status === 'signedIn' && auth.mode === 'privy' && Boolean(auth.identity) && Boolean(account?.address),
    queryFn: ({ signal }) => {
      if (!account) throw new Error('follower_statement_account_unavailable');
      return loadCopyFollowerStatement(account, { signal, snapshot: () => {
        const value = latest.current.auth;
        return { status: mounted.current ? value.status : 'disposed', mode: value.mode, identity: value.identity, session: sessionKey(), walletAddress: value.wallet?.address?.toLowerCase() ?? null };
      }, currentAccount: () => latest.current.account, read: (path, abort) => api.get(path, abort) });
    },
    retry: false, staleTime: 0, gcTime: 0,
  });
  // Refetch failures must not display an older total as the current read.
  return { ...query, data: account && !query.isError ? query.data : undefined };
}
