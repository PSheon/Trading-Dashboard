'use client';
import { useLayoutEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { copyFollowerActivityQuerySchema, copyFollowerActivitySchema, type CopyExecutionAccount, type CopyFollowerActivity } from '@trading-dashboard/shared/contracts';
import type { FollowerStatementDependencies } from './copy-follower-statements';
import { api, sessionKey } from './api';
import { useAuth } from './auth';
import { queryKeys } from './query-keys';
function identity(a: CopyExecutionAccount) { return [a.id, a.strategyId, a.network, a.address?.toLowerCase() ?? null] as const; }
export function parseCopyFollowerActivity(value: unknown, account: CopyExecutionAccount): CopyFollowerActivity {
  const page = copyFollowerActivitySchema.parse(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(account.address ?? '') || page.accountId !== account.id || page.strategyId !== account.strategyId || page.network !== account.network || page.accountAddress !== account.address?.toLowerCase()) throw new Error('follower_activity_account_changed');
  for (let i = 1; i < page.items.length; i++) if (Date.parse(page.items[i].time) > Date.parse(page.items[i - 1].time)) throw new Error('follower_activity_order_invalid');
  return page;
}
export async function loadCopyFollowerActivity(account: CopyExecutionAccount, before: string | undefined, deps: FollowerStatementDependencies): Promise<CopyFollowerActivity> {
  const selected = { ...account }, owner = { ...deps.snapshot() };
  if (owner.status !== 'signedIn' || owner.mode !== 'privy' || !owner.identity) throw new Error('follower_activity_owner_unavailable');
  const query = copyFollowerActivityQuerySchema.parse({ limit: 20, ...(before ? { before } : {}) });
  const guard = () => {
    deps.signal?.throwIfAborted();
    const currentOwner = deps.snapshot(), current = deps.currentAccount();
    if (Object.keys(owner).some(k => owner[k as keyof typeof owner] !== currentOwner[k as keyof typeof owner])) throw new Error('follower_activity_session_changed');
    if (!current || identity(selected).some((v, i) => v !== identity(current)[i])) throw new Error('follower_activity_account_changed');
  };
  if (!/^0x[0-9a-fA-F]{40}$/.test(selected.address ?? '')) throw new Error('follower_activity_account_unavailable');
  guard(); const params = new URLSearchParams({ limit: String(query.limit) }); if (query.before) params.set('before', query.before);
  const value = await deps.read(`/me/copy/execution-wallets/${encodeURIComponent(selected.id)}/activity?${params}`, deps.signal);
  guard(); const page = parseCopyFollowerActivity(value, selected);
  if (before && page.previousCursor === before) throw new Error('follower_activity_cursor_invalid');
  return page;
}
export function useCopyFollowerActivity(account: CopyExecutionAccount | null, before?: string) {
  const auth = useAuth(), latest = useRef({ auth, account }), mounted = useRef(true);
  useLayoutEffect(() => { latest.current = { auth, account }; }, [auth, account]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const enabled = auth.status === 'signedIn' && auth.mode === 'privy' && Boolean(auth.identity) && Boolean(account?.address);
  const query = useQuery({ queryKey: [...queryKeys.copy.all, 'follower-activity', auth.status, auth.mode, auth.identity, sessionKey(), auth.wallet?.address?.toLowerCase() ?? null, ...(account ? identity(account) : [null]), before ?? null], enabled,
    queryFn: ({ signal }) => {
      if (!account) throw new Error('follower_activity_account_unavailable');
      return loadCopyFollowerActivity(account, before, { signal, currentAccount: () => latest.current.account, read: (path, abort) => api.get(path, abort), snapshot: () => {
        const a = latest.current.auth; return { status: mounted.current ? a.status : 'disposed', mode: a.mode, identity: a.identity, session: sessionKey(), walletAddress: a.wallet?.address?.toLowerCase() ?? null };
      } });
    }, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false });
  return { ...query, data: enabled && !query.isError ? query.data : undefined };
}
