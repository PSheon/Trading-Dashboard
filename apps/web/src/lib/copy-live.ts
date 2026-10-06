'use client';
import { useLayoutEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { liveCopyOverviewSchema } from '@trading-dashboard/shared/contracts';
import { api, sessionKey } from './api';
import { useAuth } from './auth';
import { liveCopyEnabled } from './copy-live-setup';
import { queryKeys } from './query-keys';
import { isTransient } from './copy-error-text';

/** The owner's actual copies and their generations (read only). A live copy
 * starts one way only: setup, consent, worker (`./copy-live-setup`). */
const ROOT = '/me/copy/live';
function useLiveKey() { const a = useAuth(); return [...queryKeys.copy.all, 'actual-live', a.status, a.mode, a.identity, sessionKey(), a.wallet?.address?.toLowerCase()] as const; }
export function useLiveCopyOverview() {
  const auth = useAuth(), latest = useRef(auth), mounted = useRef(true);
  useLayoutEffect(() => { latest.current = auth; }, [auth]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = () => { const a = latest.current; return { status: mounted.current ? a.status : 'disposed', mode: a.mode, identity: a.identity, session: sessionKey(), walletAddress: a.wallet?.address?.toLowerCase() ?? null }; };
  // Privy users, and the fixture signer's stand-in (browser tests of one-click copy).
  const enabled = liveCopyEnabled(auth);
  const query = useQuery({ queryKey: useLiveKey(), enabled, queryFn: async ({ signal }) => {
    const captured = snapshot(); const guard = () => { signal.throwIfAborted(); if (JSON.stringify(captured) !== JSON.stringify(snapshot())) throw new Error('live_session_changed'); }; guard(); const result = await api.get(ROOT, signal); guard(); return liveCopyOverviewSchema.parse(result);
  }, staleTime: 0, gcTime: 0, retry: false, refetchInterval: 15000, refetchOnWindowFocus: true });
  // A passing failure of a refetch (busy, 5xx, the network) keeps the last
  // answer: a dialog open on it (edit, top-up) must not vanish mid-flow. A
  // refusal for good (4xx) or a changed session drops it.
  return { ...query, data: enabled && (!query.isError || isTransient(query.error)) ? query.data : undefined };
}
