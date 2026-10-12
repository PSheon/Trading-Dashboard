'use client';
import { useLayoutEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LiveCopySetup, LiveCopySetupAbort } from '@trading-dashboard/shared/contracts';
import { api, sessionKey } from './api';
import { useAuth } from './auth';
import { useLiveCopyDeployment } from './copy-live-setup';
import { useSiteMode } from './site-mode';
import { createSetupAbortJournal, requestSetupAbort, setupAbortFence, validateSetupAbortProgress, type SetupAbortOwner } from './copy-live-setup-abort-recovery';

/** How often an abort's progress is read again: every 3 s while it moves
 * (and until the first answer); never once there is none (404: a request
 * sets it) or it completed; every 30 s while blocked (no fast change is expected). */
export function setupAbortPollInterval(progress: LiveCopySetupAbort | null | undefined): number | false {
  if (progress === undefined) return 3000;
  if (progress === null || progress.state === 'completed') return false;
  return progress.state === 'blocked' ? 30_000 : 3000;
}

/** GET only while viewing progress. A POST happens only on the explicit
 * confirmation button and requests the same durable local abort barrier. */
export function useLiveSetupAbort(setup: LiveCopySetup) {
  const auth = useAuth(), deployment = useLiveCopyDeployment(), mode = useSiteMode(), client = useQueryClient();
  const available = deployment?.setupAbort === true;
  const readable = available || setup.abortRequested === true;
  const owner: SetupAbortOwner = { status: auth.status, mode: auth.mode, userId: auth.userId ?? null, identity: auth.identity,
    session: sessionKey(), siteMode: mode, network: deployment?.network ?? null, available };
  const selection = { id: setup.id, kind: setup.kind, strategyId: setup.strategyId, accountId: setup.accountId };
  const latest = useRef({ owner, selection }), mounted = useRef(true);
  useLayoutEffect(() => { latest.current = { owner, selection }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = () => mounted.current ? latest.current.owner : { ...latest.current.owner, available: false };
  const signedIn = auth.status === 'signedIn' && auth.mode === 'privy' && !!auth.userId && !!auth.identity;
  const correctMode = !!deployment && mode === (deployment.network === 'testnet' ? 'testnet' : 'live');
  const enabled = readable && signedIn && correctMode;
  const key = ['copy', 'setup-abort', auth.userId, auth.mode, owner.session, mode, owner.network, setup.id] as const;
  const query = useQuery<LiveCopySetupAbort | null>({ queryKey: key, enabled, retry: false,
    refetchInterval: q => setupAbortPollInterval(q.state.data),
    queryFn: async ({ signal }): Promise<LiveCopySetupAbort | null> => {
      const guard = setupAbortFence(() => ({ ...snapshot(), available: mounted.current && readable })); guard();
      try {
        const data = await api.get(`/me/copy/live/setups/${encodeURIComponent(setup.id)}/abort`, signal); guard();
        return validateSetupAbortProgress(data, selection, owner.network);
      } catch (error) {
        guard();
        if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null;
        throw error;
      }
    } });
  const request = useMutation({ mutationKey: [...key, 'request'], mutationFn: async () => {
    const guard = setupAbortFence(snapshot); guard();
    const scope = `${owner.mode}:${owner.userId}`;
    const progress = await requestSetupAbort(selection, { snapshot, current: () => latest.current.selection,
      journal: createSetupAbortJournal(scope, sessionStorage), newKey: () => crypto.randomUUID(),
      get: id => api.get(`/me/copy/live/setups/${encodeURIComponent(id)}/abort`),
      post: (id, body, beforeSend) => api.post(`/me/copy/live/setups/${encodeURIComponent(id)}/abort`, body, { beforeSend }) });
    guard(); return progress;
  }, onSuccess: progress => {
    // Late responses belong only to the captured query key, not a new owner.
    client.setQueryData(key, progress);
    void client.invalidateQueries({ queryKey: ['copy'] });
  } });
  return { available: available && signedIn && correctMode, progress: enabled ? query.data ?? null : null, loading: enabled && query.isPending,
    error: enabled ? request.error ?? query.error : null, requesting: request.isPending, refreshing: enabled && query.isFetching,
    request: request.mutate, refresh: query.refetch };
}
