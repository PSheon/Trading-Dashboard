'use client';
import { API_FIXTURES } from './config';
import { useLayoutEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { copyExecutionAccountSchema, liveCopyMandateSchema, liveCopyStopSchema, liveCopyStopsSchema, requestLiveCopyStopSchema, type CopyExecutionAccount, type LiveCopyMandate, type LiveCopyStop } from '@trading-dashboard/shared/contracts';
import { api, sessionKey } from './api';
import { useAuth } from './auth';

export interface LiveStopSelection { account: CopyExecutionAccount; mandate: LiveCopyMandate }
const attemptSchema = z.object({ request: requestLiveCopyStopSchema, accountId: z.string().min(1).max(128), mandateId: z.string().min(1).max(128), strategyId: z.number().int().positive(), network: z.literal('testnet'), accountAddress: z.string().regex(/^0x[0-9a-f]{40}$/), ownerId: z.string().min(1).max(128).nullable().default(null), dispatchState: z.enum(['unsent', 'possible_sent']).default('possible_sent') }).strict().refine(v => v.dispatchState !== 'unsent' || v.ownerId !== null);
const journalSchema = z.array(attemptSchema).max(100).refine(items => new Set(items.map(i => i.mandateId)).size === items.length && new Set(items.map(i => i.request.idempotencyKey)).size === items.length);
export type LiveStopAttempt = z.infer<typeof attemptSchema>;
/** Only immutable recovery metadata is stored, never tokens or signatures. */
export function createLiveStopJournal(owner: string, storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `copy-live-stops:v1:${encodeURIComponent(owner)}`;
  const read = () => { const raw = storage.getItem(key); if (raw && raw.length > 131072) throw new Error('stop_storage'); return raw ? journalSchema.parse(JSON.parse(raw)) : []; };
  const write = (items: LiveStopAttempt[]) => {
    const raw = JSON.stringify(journalSchema.parse(items));
    if (raw.length > 131072) throw new Error('stop_storage');
    storage.setItem(key, raw); if (storage.getItem(key) !== raw) throw new Error('stop_storage');
  };
  return { read, save(input: z.input<typeof attemptSchema>) {
    const attempt = attemptSchema.parse(input);
    const items = read(), previous = items.find(i => i.mandateId === attempt.mandateId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(attempt)) throw new Error('stop_binding');
    write(previous ? items : [...items, attempt]);
  }, markPossibleSent(attempt: LiveStopAttempt) {
    const items = read(), previous = items.find(i => i.mandateId === attempt.mandateId);
    if (!previous || previous.dispatchState !== 'unsent' || JSON.stringify(previous) !== JSON.stringify(attempt)) throw new Error('stop_dispatch_changed');
    // Durable and irreversible before fetch: a lost response can only use GET.
    write(items.map(i => i.mandateId === attempt.mandateId ? { ...i, dispatchState: 'possible_sent' } : i));
  }, discardUnsent(attempt: LiveStopAttempt, beforeWrite: () => void) {
    const items = read(), previous = items.find(i => i.mandateId === attempt.mandateId);
    if (!previous || previous.dispatchState !== 'unsent' || attempt.dispatchState !== 'unsent' || JSON.stringify(previous) !== JSON.stringify(attempt)) throw new Error('stop_discard_changed');
    beforeWrite();
    if (JSON.stringify(read()) !== JSON.stringify(items)) throw new Error('stop_discard_changed');
    beforeWrite(); write(items.filter(i => i.mandateId !== attempt.mandateId));
  } };
}
export interface LiveStopOwner { status: string; mode: string; identity: string | null; session: string; ownerId: string | null }
interface StopDeps {
  snapshot(): LiveStopOwner; current(): LiveStopSelection | null;
  journal: ReturnType<typeof createLiveStopJournal>; newKey(): string;
  post(id: string, body: LiveStopAttempt['request'], beforeSend: () => void): Promise<unknown>;
  find(key: string): Promise<unknown>;
}
function ownerFence(deps: Pick<StopDeps, 'snapshot'>) {
  const original = { ...deps.snapshot() };
  if (original.status !== 'signedIn' || original.mode !== 'privy' || !original.identity || !original.ownerId) throw new Error('stop_owner');
  return () => { if (JSON.stringify(original) !== JSON.stringify(deps.snapshot())) throw new Error('stop_owner_changed'); };
}
/** Explicit local retirement is permitted only for an exactly matched unsent draft. */
export function discardUnsentLiveCopyStop(attempt: LiveStopAttempt, deps: Pick<StopDeps, 'snapshot' | 'journal'>): void {
  const fence = ownerFence(deps); fence();
  if (attempt.dispatchState !== 'unsent' || !attempt.ownerId || attempt.ownerId !== deps.snapshot().ownerId) throw new Error('stop_discard_unavailable');
  deps.journal.discardUnsent(attempt, fence); fence();
}
function validateResult(raw: unknown, attempt: LiveStopAttempt): LiveCopyStop {
  const result = liveCopyStopSchema.parse(raw);
  if (result.accountId !== attempt.accountId || result.mandateId !== attempt.mandateId || result.strategyId !== attempt.strategyId || result.network !== attempt.network || result.accountAddress !== attempt.accountAddress || result.originalMandateRevision !== attempt.request.expectedMandateRevision) throw new Error('stop_result_changed');
  return result;
}
/** Read-only recovery never turns a missing result into permission to POST. */
export async function recoverLiveCopyStop(attempt: LiveStopAttempt, deps: StopDeps) {
  const fence = ownerFence(deps); fence();
  if (attempt.ownerId !== null && attempt.ownerId !== deps.snapshot().ownerId || !deps.journal.read().some(item => JSON.stringify(item) === JSON.stringify(attempt))) throw new Error('stop_binding');
  const raw = await deps.find(attempt.request.idempotencyKey); fence(); return validateResult(raw, attempt);
}
export function canResumeLiveCopyStop(attempt: LiveStopAttempt, selection: LiveStopSelection | null, ownerId: string | null): boolean {
  if (!selection || attempt.dispatchState !== 'unsent' || !ownerId || attempt.ownerId !== ownerId) return false;
  const { account: a, mandate: m } = selection;
  return m.mode === 'actual' && m.network === 'testnet' && a.network === m.network && a.id === m.accountId && a.strategyId === m.strategyId && a.address === m.accountAddress && attempt.accountId === a.id && attempt.accountAddress === a.address && attempt.strategyId === m.strategyId && attempt.mandateId === m.id && attempt.request.expectedMandateRevision === m.revision && !['prepared', 'stopping', 'stopped'].includes(m.state) && m.activationCursor !== null;
}
export async function requestLiveCopyStop(input: LiveStopSelection, deps: StopDeps) {
  const original = structuredClone({ account: copyExecutionAccountSchema.parse(input.account), mandate: liveCopyMandateSchema.parse(input.mandate) });
  const { account: a, mandate: m } = original, owner = ownerFence(deps);
  if (m.mode !== 'actual' || m.network !== 'testnet' || a.network !== m.network || a.id !== m.accountId || a.strategyId !== m.strategyId || a.address !== m.accountAddress) throw new Error('stop_binding');
  const guard = () => { owner(); const current = deps.current(); if (!current || JSON.stringify(original) !== JSON.stringify({ account: copyExecutionAccountSchema.parse(current.account), mandate: liveCopyMandateSchema.parse(current.mandate) })) throw new Error('stop_binding_changed'); }; guard();
  const previous = deps.journal.read().find(item => item.mandateId === m.id);
  if (previous) {
    if (previous.accountId !== a.id || previous.accountAddress !== a.address || previous.strategyId !== m.strategyId) throw new Error('stop_binding_changed');
    if (previous.dispatchState !== 'unsent') return recoverLiveCopyStop(previous, deps);
    if (!canResumeLiveCopyStop(previous, original, deps.snapshot().ownerId)) throw new Error('stop_binding_changed');
  }
  if (m.state === 'stopping' || m.state === 'stopped') throw new Error('stop_already_started');
  if (m.state === 'prepared' || m.activationCursor === null) throw new Error('stop_unapproved');
  const attempt = previous ?? attemptSchema.parse({ request: { idempotencyKey: deps.newKey(), expectedMandateRevision: m.revision }, accountId: a.id, mandateId: m.id, strategyId: m.strategyId, network: m.network, accountAddress: m.accountAddress, ownerId: deps.snapshot().ownerId, dispatchState: 'unsent' });
  deps.journal.save(attempt); guard();
  const beforeSend = () => { guard(); deps.journal.markPossibleSent(attempt); guard(); };
  const raw = await deps.post(m.id, attempt.request, beforeSend); owner(); return validateResult(raw, attempt);
}

export function useLiveCopyStops(selection: LiveStopSelection | null, ownerId: string | null) {
  const auth = useAuth(), client = useQueryClient();
  const owner = { status: auth.status, mode: auth.mode, identity: auth.identity, session: sessionKey(), ownerId };
  const enabled = owner.status === 'signedIn' && (owner.mode === 'privy' || (API_FIXTURES && owner.mode === 'fixture')) && !!owner.identity && !!ownerId;
  const scope = enabled ? `privy:${ownerId}` : null;
  const key = ['copy', 'live-stops', owner.ownerId, owner.session] as const;
  const latest = useRef({ owner, selection, scope });
  const mounted = useRef(false), busy = useRef(false);
  useLayoutEffect(() => { latest.current = { owner, selection, scope }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const recoveryKey = [...key, 'recovery'] as const;
  const recovery = useQuery({ queryKey: recoveryKey, enabled, retry: false, gcTime: 0, staleTime: 0, queryFn: async () => {
    if (!scope) throw new Error('stop_owner'); return createLiveStopJournal(scope, window.sessionStorage).read();
  } });
  const history = useQuery({ queryKey: key, enabled, queryFn: async ({ signal }) => {
    const data = liveCopyStopsSchema.parse(await api.get('/me/copy/live/stops', signal));
    const previous = client.getQueryData<z.infer<typeof liveCopyStopsSchema>>(key);
    return { ...data, items: data.items.map(item => { const old = previous?.items.find(v => v.id === item.id); return old && old.revision > item.revision ? old : item; }) };
  }, retry: false, staleTime: 0, refetchInterval: enabled ? 15000 : false });
  const mutation = useMutation({ retry: false, mutationFn: async (attempt?: LiveStopAttempt) => {
    if (busy.current || !mounted.current || !scope) throw new Error('stop_busy');
    busy.current = true;
    const journal = createLiveStopJournal(scope, window.sessionStorage);
    const deps: StopDeps = {
      snapshot: () => { if (!mounted.current) throw new Error('stop_unmounted'); return latest.current.owner; }, current: () => latest.current.selection,
      journal, newKey: () => crypto.randomUUID(),
      post: (id, body, beforeSend) => api.post(`/me/copy/live/mandates/${encodeURIComponent(id)}/stop`, body, { beforeSend }),
      find: key => api.get(`/me/copy/live/stops/by-key/${encodeURIComponent(key)}`),
    };
    try {
      if (JSON.stringify(owner) !== JSON.stringify(latest.current.owner)) throw new Error('stop_owner_changed');
      if (attempt?.dispatchState === 'unsent') {
        if (!canResumeLiveCopyStop(attempt, selection, ownerId)) throw new Error('stop_binding_changed');
        return await requestLiveCopyStop(selection!, deps);
      }
      return attempt ? await recoverLiveCopyStop(attempt, deps) : selection ? await requestLiveCopyStop(selection, deps) : Promise.reject(new Error('stop_selection'));
    } finally {
      busy.current = false;
      if (mounted.current && latest.current.scope === scope && latest.current.owner.session === owner.session) await client.invalidateQueries({ queryKey: recoveryKey, exact: true });
    }
  }, onSuccess: result => {
    if (!mounted.current || JSON.stringify(owner) !== JSON.stringify(latest.current.owner)) return;
    client.setQueryData<z.infer<typeof liveCopyStopsSchema>>(key, previous => { const old = previous?.items.find(item => item.id === result.id); return { items: [old && old.revision > result.revision ? old : result, ...(previous?.items ?? []).filter(item => item.id !== result.id)], truncated: previous?.truncated ?? false }; });
    void client.invalidateQueries({ queryKey: ['copy', 'actual-live'] });
    void client.invalidateQueries({ queryKey: key });
  } });
  const discard = useMutation({ retry: false, mutationFn: async (attempt: LiveStopAttempt) => {
    if (busy.current || !mounted.current || !scope) throw new Error('stop_busy');
    busy.current = true;
    try {
      if (JSON.stringify(owner) !== JSON.stringify(latest.current.owner)) throw new Error('stop_owner_changed');
      discardUnsentLiveCopyStop(attempt, {
        snapshot: () => { if (!mounted.current) throw new Error('stop_unmounted'); return latest.current.owner; },
        journal: createLiveStopJournal(scope, window.sessionStorage),
      });
    } finally {
      busy.current = false;
      if (mounted.current && latest.current.scope === scope && latest.current.owner.session === owner.session) await client.invalidateQueries({ queryKey: recoveryKey, exact: true });
    }
  }, onSuccess: () => {
    if (mounted.current && JSON.stringify(owner) === JSON.stringify(latest.current.owner)) mutation.reset();
  } });
  return { enabled, history, attempts: recovery.data ?? [], storageError: recovery.isError, storageReady: recovery.isSuccess, mutation, discard };
}
