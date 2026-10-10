'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { liveCopyMandateSchema, liveCopyOverviewSchema, liveCopySetupConsentTypedData, liveCopySetupSchema, LIVE_SETUP_TERMINAL, usdSendTypedData, WALLET_NETWORKS,
  type CopyStrategySettings, type LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { api, ApiError, sessionKey } from './api';
import { useAuth } from './auth';
import { isTransient, retryAfter } from './copy-error-text';
import { createLiveSetupJournal, setupRequestDigest, type LiveSetupAttempt } from './copy-live-setup-recovery';
export { createLiveSetupJournal } from './copy-live-setup-recovery';
import { createSetupAbortJournal, validateSetupAbortProgress } from './copy-live-setup-abort-recovery';
import { FIXTURE_WALLET_ADDRESS } from './fixture-signer';
import { queryKeys } from './query-keys';
import type { Eip712TypedData, WalletSigner } from './wallet-signer';

const ROOT = '/me/copy/live';
type Auth = ReturnType<typeof useAuth>;

/** Testnet copy runs for a signed-in Privy user (and, in fixture mode, only
 * with the fixture signer: `?signer=fixture`). */
export function liveCopyEnabled(auth: Pick<Auth, 'status' | 'mode' | 'identity' | 'wallet'>): boolean {
  return auth.status === 'signedIn' && Boolean(auth.identity) && (auth.mode === 'privy' || (auth.mode === 'fixture' && auth.wallet?.address === FIXTURE_WALLET_ADDRESS));
}

/** The deployment's actual copy: the network it executes on (the server's
 * HYPERLIQUID_NETWORK, never assumed here), whether it runs and this owner may
 * start one, the leaders' networks it copies and its caps. Null until the
 * signed-in overview answered (or for a visitor). */
export interface LiveCopyDeployment {
  /** Explicit server capability; an older deployment does not expose abort. */
  setupAbort?: boolean;
  network: 'testnet' | 'mainnet'; available: boolean; sourceNetworks: ReadonlyArray<'testnet' | 'mainnet'>;
  caps: { fixedPerTradeUsd: { min: number; max: number } | null; maxAllocationUsd: number | null; maxLeverage: number | null; maxStrategiesPerUser: number } | null;
  /** Actual copies run here, but not for this owner yet (`actualAllowed: false`: invited users only). */
  inviteOnly?: boolean;
}
export function useLiveCopyDeployment(): LiveCopyDeployment | null {
  const auth = useAuth(), enabled = liveCopyEnabled(auth);
  // Once a minute at most: the site-wide 10 s poll would otherwise reread
  // it on every trader page (web audit L5).
  const query = useQuery({ queryKey: [...queryKeys.copy.all, 'live-capabilities', auth.identity, sessionKey()], enabled, staleTime: 60_000, refetchInterval: 60_000, retry: false,
    queryFn: async ({ signal }) => { const overview = liveCopyOverviewSchema.parse(await api.get(ROOT, signal)); return { network: overview.network, capabilities: overview.capabilities }; } });
  if (!enabled || !query.data) return null;
  const { network, capabilities } = query.data;
  return { network, available: capabilities.automaticExecution && capabilities.actualAllowed !== false, sourceNetworks: capabilities.sourceNetworks, caps: capabilities.caps ?? null,
    setupAbort: capabilities.setupAbort === true,
    inviteOnly: capabilities.automaticExecution && capabilities.actualAllowed === false };
}
/** Whether this deployment runs actual copies for this owner (`capabilities.automaticExecution`
 * and, on a live deployment, `actualAllowed`). */
export function useLiveCopyAvailable(): boolean {
  return useLiveCopyDeployment()?.available === true;
}

export const setupTerminal = (setup: Pick<LiveCopySetup, 'stage'> | null | undefined) => Boolean(setup && LIVE_SETUP_TERMINAL.includes(setup.stage));

export interface StartLiveCopyInput { leader: string; budgetUsd: string; settings: CopyStrategySettings;
  /** The leader's network (default mainnet: trader pages are mainnet; a testnet deployment may copy a testnet leader). */
  sourceNetwork?: 'testnet' | 'mainnet' }

/** The setup consent and the deposit, signed without Privy's modal: called
 * only from Orbie's confirm sheet, which lists every term (decision 1). */
export async function signSetup(setup: LiveCopySetup, sign: (data: Eip712TypedData, options: { silent: boolean }) => Promise<string>, timeoutMs = SIGN_TIMEOUT_MS) {
  if (!setup.consent) throw new Error('setup_consent_expired');
  const consent = setup.consent;
  const consentSignature = await withSignTimeout(sign(liveCopySetupConsentTypedData(consent) as unknown as Eip712TypedData, { silent: true }), timeoutMs);
  const fundingSignature = consent.kind === 'start'
    ? await withSignTimeout(sign(usdSendTypedData(WALLET_NETWORKS[consent.network], consent.accountAddress, consent.fundingAmount, consent.fundingNonce) as unknown as Eip712TypedData, { silent: true }), timeoutMs) : undefined;
  return { consentSignature, ...(fundingSignature ? { fundingSignature } : {}) };
}
/** How long a silent signature may take before confirm gives up on it (the sheet can close again). */
export const SIGN_TIMEOUT_MS = 90_000;
/** Privy's signTypedData has no limit of its own: past `ms` it is `signing_timeout`. */
function withSignTimeout<T>(signing: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('signing_timeout')), ms); });
  return Promise.race([signing, late]).finally(() => clearTimeout(timer));
}

/**
 * The one signing model (2026-10-07): the owner's browser adds exactly the
 * worker quorum under the owner-owned policy the consent bound as the copy
 * account's signer (Privy's addSigners: only the owner can); the worker then
 * signs every step of the setup, the returns and the stop. Declined, failed
 * or not answered within `timeoutMs`: throws `worker_signer_missing`, so
 * confirm is never sent and nothing is deposited. Confirming again (while
 * the consent lasts) asks again.
 */
export async function attachWorker(setup: LiveCopySetup, wallet: Pick<WalletSigner, 'addSigners'>, timeoutMs = ATTACH_WORKER_TIMEOUT_MS,
  onLate: (accountId: string) => void = () => undefined): Promise<void> {
  const consent = setup.consent;
  // An edit of a running copy deposits nothing and signs nothing new.
  if (consent?.kind === 'edit') return;
  if (!consent || consent.kind !== 'start' || !consent.masterPolicyId || !consent.workerQuorumId) throw new Error('worker_signer_missing');
  let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
  const late = new Promise<false>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(false); }, timeoutMs); });
  const added = wallet.addSigners(consent.accountAddress, [{ signerId: consent.workerQuorumId, policyIds: [consent.masterPolicyId] }]).then(() => true, () => false);
  // The signer landing after confirm gave up: the account's next reconcile
  // adopts exactly the consented policy (the api's orphan adoption), so a
  // retried confirm finds it.
  void added.then(ok => { if (ok && timedOut) onLate(consent.accountId); });
  try { if (!await Promise.race([added, late])) throw new Error('worker_signer_missing'); }
  finally { clearTimeout(timer); }
}
/** How long confirm waits for Privy to add the worker signer. */
export const ATTACH_WORKER_TIMEOUT_MS = 20_000;

/** A payload's fingerprint for its attempt name: keys sorted, so the terms
 * the server echoes back (jsonb reorders keys) name the same attempt. */
export function termsFingerprint(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(key => [key, stable((v as Record<string, unknown>)[key])])) : v;
  return JSON.stringify(stable(value));
}

/**
 * The idempotency key of each attempt (`start:<leader>:<terms>`,
 * `edit:<id>:<terms>`, `renew:<id>`, `topup:…`), for the tab and identity generation: a
 * remounted panel or row retries the same terms with the same key and the
 * server answers with the same setup; changed terms (the sheet dismissed,
 * the amount changed) are a new attempt with a new key, never a 409
 * "payload changed" or the old setup's terms on the sheet.
 * Opaque recovery identifiers survive reload in sessionStorage. Scoped to
 * stable auth mode and owner for reload recovery. Runtime session generation
 * still fences every in-flight handle; recovered operations are read first.
 */
const setupKeys = new Map<string, LiveSetupAttempt>();
let setupKeysScope: string | null = null;
export function liveSetupScope(identity: string | null): string | null {
  return identity ? `${identity}#${sessionKey()}` : null;
}
function scopedKeys(scope: string | null) {
  if (scope !== setupKeysScope) { setupKeys.clear(); setupKeysScope = scope; }
  return setupKeys;
}

/**
 * One-click start, edit and renewal (docs/one-click-copy-plan-2026-10-05.md):
 * `start` prepares the setup and returns its consent challenge (one key per
 * attempt, reused by a retry so the server answers with the same setup);
 * `confirm` signs the consent and the deposit silently and sends them.
 * A session change between the two aborts. `restart` begins a setup that
 * ended (or whose consent expired) again with the same terms, under a new
 * key (the server ends the old one); `cancel` ends one that is not running
 * a step.
 */
export function useLiveCopySetupActions() {
  const auth = useAuth(), client = useQueryClient();
  // The session as it is now (a sign-in or account switch mid-flow aborts).
  const latest = useRef(auth);
  useLayoutEffect(() => { latest.current = auth; });
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const keys = () => scopedKeys(liveSetupScope(latest.current.identity));
  const journal = () => {
    const scope = liveSetupScope(latest.current.identity);
    if (!scope || !liveCopyEnabled(latest.current)) throw new Error('live_session_changed');
    return createLiveSetupJournal(`${latest.current.mode}:${latest.current.identity}`, window.sessionStorage);
  };
  const keyFor = async (name: string) => {
    const scope = liveSetupScope(latest.current.identity), request = await setupRequestDigest(name);
    if (!mounted.current || liveSetupScope(latest.current.identity) !== scope) throw new Error('live_session_changed');
    const map = keys(), inMemory = map.get(name), stored = journal().find(request);
    const attempt = inMemory ?? stored ?? { request, key: crypto.randomUUID(), setupId: null, network: null, confirmationPending: false };
    journal().save(attempt); map.set(name, attempt);
    return { attempt, restored: !inMemory && Boolean(stored) };
  };
  const forget = async (name: string) => {
    const scope = liveSetupScope(latest.current.identity), request = await setupRequestDigest(name);
    assertScope(scope);
    journal().forget(request); keys().delete(name);
  };
  /** The attempt names a setup was made under (exact names only). */
  const startName = (leader: string, budgetUsd: string, settings: unknown, sourceNetwork: 'testnet' | 'mainnet' = 'mainnet') => `start:${leader}:${termsFingerprint({ budgetUsd, settings, sourceNetwork })}`;
  const editName = (strategyId: number, budgetUsd: string, settings: unknown) => `edit:${strategyId}:${termsFingerprint({ budgetUsd, settings })}`;
  const namesOf = (setup: Pick<LiveCopySetup, 'kind' | 'strategyId' | 'leaderAddress' | 'budgetUsd' | 'settings' | 'sourceNetwork'>) => setup.kind === 'start' ? [startName(setup.leaderAddress, setup.budgetUsd, setup.settings, setup.sourceNetwork)]
    : [editName(setup.strategyId, setup.budgetUsd, setup.settings), `renew:${setup.strategyId}`];
  const refresh = () => { void client.invalidateQueries({ queryKey: [...queryKeys.copy.all] }); };
  /** The progress dialog opens on what the server just answered: a first
   * poll that fails in passing still shows the stages (never an empty list). */
  const seed = (setup: LiveCopySetup) => { client.setQueryData(liveSetupKey(setup.id, latest.current.identity), setup); return setup; };
  const owner = () => {
    const current = latest.current, wallet = current.wallet, identity = current.identity, session = sessionKey();
    if (!wallet || !liveCopyEnabled(current)) throw new Error('owner_wallet_unavailable');
    return { wallet, assertSame: () => { if (!mounted.current || !liveCopyEnabled(latest.current) || latest.current.identity !== identity || latest.current.wallet?.address !== wallet.address || sessionKey() !== session) throw new Error('live_session_changed'); } };
  };
  const assertScope = (scope: string | null) => {
    if (!mounted.current || liveSetupScope(latest.current.identity) !== scope || !liveCopyEnabled(latest.current)) throw new Error('live_session_changed');
  };
  const uncertainResponse = (error: unknown) => isTransient(error) || error instanceof ApiError && error.status >= 500;
  const assertRecovery = (attempt: LiveSetupAttempt, setup: LiveCopySetup) => {
    if (attempt.setupId && setup.id !== attempt.setupId) throw new Error('setup_identity_mismatch');
    const observed = setup.consent?.network ?? setup.funding?.network;
    if (attempt.network && observed && observed !== attempt.network) throw new Error('setup_identity_mismatch');
  };
  const remember = (name: string, attempt: LiveSetupAttempt, setup: LiveCopySetup) => {
    if (attempt.setupId && attempt.setupId !== setup.id) throw new Error('setup_identity_mismatch');
    const network = setup.consent?.network ?? setup.funding?.network ?? attempt.network;
    if (attempt.network && network !== attempt.network) throw new Error('setup_identity_mismatch');
    const updated = { ...attempt, setupId: setup.id, network };
    journal().save(updated); keys().set(name, updated);
    return seed(setup);
  };
  /** The server owns provisioning after admission. A lost answer is read
   * back by the original key; it never authorizes a new attempt or signature. */
  const prepare = async (name: string, send: (key: string) => Promise<unknown>) => {
    const scope = liveSetupScope(latest.current.identity);
    const { attempt, restored } = await keyFor(name);
    const recover = async () => {
      const result = liveCopySetupSchema.parse(await api.get(`${ROOT}/setups/by-key/${encodeURIComponent(attempt.key)}`));
      assertScope(scope);
      if (!namesOf(result).includes(name)) throw new Error('setup_identity_mismatch');
      return remember(name, attempt, result);
    };
    if (restored) {
      try { return await recover(); }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      // An explicit retry after a confirmed missing admission retains its
      // old key. Never issue a fresh key because a response was lost.
    }
    assertScope(scope);
    try {
      const result = liveCopySetupSchema.parse(await send(attempt.key));
      assertScope(scope); return remember(name, attempt, result);
    } catch (error) {
      assertScope(scope);
      if (!uncertainResponse(error)) throw error;
      try { return await recover(); }
      catch { assertScope(scope); throw error; }
    }
  };
  const start = useMutation({
    mutationFn: async (input: StartLiveCopyInput) => prepare(startName(input.leader, input.budgetUsd, input.settings, input.sourceNetwork ?? 'mainnet'), key => api.post(`${ROOT}/setups`, { idempotencyKey: key, leader: input.leader, sourceNetwork: input.sourceNetwork ?? 'mainnet', budgetUsd: input.budgetUsd, settings: input.settings })),
  });
  const edit = useMutation({
    mutationFn: async ({ strategyId, budgetUsd, settings, afterAbortedSetupId, afterAbortedSetupNetwork }: { strategyId: number; budgetUsd: string; settings: CopyStrategySettings; afterAbortedSetupId?: string; afterAbortedSetupNetwork?: 'testnet' | 'mainnet' }) => {
      if (afterAbortedSetupId) {
        if (!afterAbortedSetupNetwork) throw new Error('setup_abort_progress_changed');
        const scope = liveSetupScope(latest.current.identity);
        assertScope(scope);
        const original = liveCopySetupSchema.parse(await api.get(`${ROOT}/setups/${encodeURIComponent(afterAbortedSetupId)}`));
        assertScope(scope);
        if (original.id !== afterAbortedSetupId || original.strategyId !== strategyId || original.kind === 'start' ||
          original.stage !== 'cancelled' || !original.abortRequested || !original.accountId) throw new Error('setup_abort_progress_changed');
        const progress = validateSetupAbortProgress(await api.get(`${ROOT}/setups/${encodeURIComponent(original.id)}/abort`), original, afterAbortedSetupNetwork);
        assertScope(scope);
        if (progress.state !== 'completed') throw new Error('setup_abort_progress_changed');
        // A new explicit edit may retire only this original operation's
        // preparation key. A later attempt under the same terms survives.
        const name = original.kind === 'edit' ? editName(strategyId, original.budgetUsd, original.settings) : `renew:${strategyId}`;
        const request = await setupRequestDigest(name);
        assertScope(scope);
        const matches = (attempt: LiveSetupAttempt | undefined) => attempt?.setupId === original.id &&
          (attempt.network === null || attempt.network === progress.network);
        if (matches(journal().find(request))) journal().forget(request);
        if (matches(keys().get(name))) keys().delete(name);
      }
      return prepare(editName(strategyId, budgetUsd, settings), key => api.patch(`${ROOT}/strategies/${strategyId}`, { idempotencyKey: key, budgetUsd, settings }));
    },
  });
  const renew = useMutation({
    mutationFn: async ({ strategyId }: { strategyId: number }) => prepare(`renew:${strategyId}`, key => api.post(`${ROOT}/strategies/${strategyId}/renew`, { idempotencyKey: key })),
  });
  /** What confirm is waiting for, for the sheet to say (adding the worker signer can take a while). */
  const [confirmPhase, setConfirmPhase] = useState<'wallet' | 'attaching' | null>(null);
  const readyOwner = async (setup: LiveCopySetup) => {
    const identity = latest.current.identity, session = sessionKey(), deadline = Date.now() + 30_000;
    for (;;) {
      const current = latest.current;
      if (!mounted.current || current.identity !== identity || sessionKey() !== session || !liveCopyEnabled(current)) throw new Error('live_session_changed');
      if (current.wallet?.address) {
        if (!setup.consent || current.wallet.address.toLowerCase() !== setup.consent.ownerAddress.toLowerCase()) throw new Error('live_session_changed');
        return owner();
      }
      if (Date.now() >= deadline) throw new Error('owner_wallet_unavailable');
      setConfirmPhase('wallet');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const confirm = useMutation({
    mutationFn: async (setup: LiveCopySetup) => {
      const scope = liveSetupScope(latest.current.identity), request = await setupRequestDigest(`confirm:${setup.id}`);
      assertScope(scope);
      const original = journal().find(request);
      if (original?.confirmationPending) {
        const recovered = liveCopySetupSchema.parse(await api.get(`${ROOT}/setups/${encodeURIComponent(setup.id)}`));
        assertScope(scope);
        assertRecovery(original, recovered);
        if (recovered.stage !== 'awaiting_consent' || recovered.issue === 'funding_not_submitted') journal().forget(request);
        return seed(recovered);
      }
      let ready: ReturnType<typeof owner>;
      try { ready = await readyOwner(setup); } finally { setConfirmPhase(null); }
      const { wallet, assertSame } = ready;
      const body = await signSetup(setup, (data, options) => { assertSame(); return wallet.signTypedData(data, options); });
      assertSame();
      setConfirmPhase('attaching');
      // Declined or timed out: throws, so no /confirm is sent and nothing is deposited.
      try {
        await attachWorker(setup, wallet, ATTACH_WORKER_TIMEOUT_MS,
          accountId => void api.post(`/me/copy/execution-wallets/${encodeURIComponent(accountId)}/reconcile`, {}).catch(() => undefined));
      } finally { setConfirmPhase(null); }
      assertSame();
      const attempt: LiveSetupAttempt = { request, key: original?.key ?? crypto.randomUUID(), setupId: setup.id,
        network: setup.consent?.network ?? setup.funding?.network ?? null, confirmationPending: true };
      journal().save(attempt);
      let result: LiveCopySetup;
      try { result = liveCopySetupSchema.parse(await api.post(`${ROOT}/setups/${encodeURIComponent(setup.id)}/confirm`, body)); }
      catch (error) {
        assertSame();
        if (!uncertainResponse(error)) { journal().forget(request); throw error; }
        try { result = liveCopySetupSchema.parse(await api.get(`${ROOT}/setups/${encodeURIComponent(setup.id)}`)); }
        catch { assertSame(); throw error; }
      }
      assertSame();
      assertRecovery(attempt, result);
      if (result.stage !== 'awaiting_consent' || result.issue === 'funding_not_submitted') journal().forget(request);
      seed(result);
      if (result.stage !== 'awaiting_consent' && result.stage !== 'provisioning') for (const name of namesOf(setup)) await forget(name);
      refresh(); return result;
    },
  });
  /** Before its consent, or once it failed or expired (a start that never
   * ran stops; a deposit that arrived is returned from the portfolio). */
  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const scope = liveSetupScope(latest.current.identity);
      const result = liveCopySetupSchema.parse(await api.post(`${ROOT}/setups/${encodeURIComponent(id)}/cancel`, {}));
      assertScope(scope);
      for (const name of namesOf(result)) await forget(name);
      refresh(); return result;
    },
  });
  /** The same terms again under a new key: a fresh consent challenge. */
  const restart = useMutation({
    mutationFn: async (setupOrId: LiveCopySetup | string) => {
      const scope = liveSetupScope(latest.current.identity);
      const setup = typeof setupOrId === 'string' ? liveCopySetupSchema.parse(await api.get(`${ROOT}/setups/${encodeURIComponent(setupOrId)}`)) : setupOrId;
      assertScope(scope);
      for (const name of namesOf(setup)) await forget(name);
      const next = setup.kind === 'start' ? await start.mutateAsync({ leader: setup.leaderAddress, budgetUsd: setup.budgetUsd, settings: setup.settings, sourceNetwork: setup.sourceNetwork })
        : setup.kind === 'edit' ? await edit.mutateAsync({ strategyId: setup.strategyId, budgetUsd: setup.budgetUsd, settings: setup.settings })
        : await renew.mutateAsync({ strategyId: setup.strategyId });
      refresh(); return next;
    },
  });
  /** No signature: the generation's consent covers it. */
  const resume = useMutation({
    mutationFn: async (mandateId: string) => { const result = liveCopyMandateSchema.parse(await api.post(`${ROOT}/mandates/${encodeURIComponent(mandateId)}/resume`, {})); refresh(); return result; },
  });
  const pause = useMutation({
    mutationFn: async (mandateId: string) => { const result = liveCopyMandateSchema.parse(await api.post(`${ROOT}/mandates/${encodeURIComponent(mandateId)}/pause`, {})); refresh(); return result; },
  });
  /** 加碼: the main wallet's UsdSend to the copy account, signed silently
   * after Orbie's confirm, through the deposit's own one-attempt path. */
  const topUp = useMutation({
    mutationFn: async ({ accountId, amount }: { accountId: string; amount: string }) => {
      const { wallet, assertSame } = owner(), name = `topup:${accountId}:${amount}`;
      const { attempt } = await keyFor(name);
      assertSame();
      const reserved = await api.post<{ id: string; network: 'testnet' | 'mainnet'; destination: string; amount: string; nonce: number; status: string }>(`/me/copy/execution-wallets/${encodeURIComponent(accountId)}/funding`, { idempotencyKey: attempt.key, amount });
      assertSame();
      // The same attempt again (this key): already sent, or refused (an error, not a quiet close).
      if (reserved.status !== 'prepared') {
        await forget(name); refresh();
        if (reserved.status === 'rejected' || reserved.status === 'cancelled') throw new ApiError(409, 'The deposit was refused', { code: 'setup_funding_rejected' });
        return reserved;
      }
      // The deposit's own network (the deployment's, as the server reserved it).
      if (reserved.network !== 'testnet' && reserved.network !== 'mainnet') throw new Error('funding_network_unknown');
      const signature = await wallet.signTypedData(usdSendTypedData(WALLET_NETWORKS[reserved.network], reserved.destination, reserved.amount, reserved.nonce) as unknown as Eip712TypedData, { silent: true });
      assertSame();
      await api.post(`/me/copy/funding/${encodeURIComponent(reserved.id)}/broadcast`, {});
      const result = await api.post(`/me/copy/funding/${encodeURIComponent(reserved.id)}/submit`, { signature });
      assertSame(); await forget(name); refresh(); return result;
    },
  });
  const hasSavedAbortIntent = (setupId: string | null, network: 'testnet' | 'mainnet' | null) => {
    const current = auth;
    if (!setupId || !network || typeof window === 'undefined' || current.status !== 'signedIn' || current.mode !== 'privy' || !current.userId) return false;
    try { return createSetupAbortJournal(`${current.mode}:${current.userId}`, window.sessionStorage).read().some(attempt => attempt.setup.id === setupId && attempt.network === network); }
    catch { return true; } // An unreadable original journal cannot authorize starting another operation.
  };
  return { start, edit, renew, confirm, confirmPhase, cancel, restart, resume, pause, topUp, hasSavedAbortIntent };
}

/** One setup's poll, for this person and session. */
function liveSetupKey(id: string | null, identity: string | null) {
  return [...queryKeys.copy.all, 'live-setup', id, identity, sessionKey()] as const;
}

/**
 * One setup, polled every 2 s until it finishes. The worker runs every step
 * after confirm (its own pass, every few seconds), so the dialog only reads;
 * nothing here signs or drives anything.
 */
export function useLiveCopySetup(id: string | null) {
  const auth = useAuth(), enabled = Boolean(id) && liveCopyEnabled(auth);
  const query = useQuery<LiveCopySetup>({
    queryKey: liveSetupKey(id, auth.identity), enabled, retry: false, staleTime: 0,
    // Ended, or refused for good (signed out, not this owner's: a 4xx): no
    // more polling. A passing failure (network, 5xx, Hyperliquid busy) is
    // asked again after the api's Retry-After, else 10 s.
    refetchInterval: q => setupTerminal(q.state.data) || (q.state.error instanceof ApiError && q.state.error.status >= 400 && q.state.error.status < 500) ? false
      : q.state.error ? retryAfter(q.state.error, 10_000) : 2000,
    queryFn: async ({ signal }): Promise<LiveCopySetup> => liveCopySetupSchema.parse(await api.get(`${ROOT}/setups/${encodeURIComponent(id!)}`, signal)),
  });
  const client = useQueryClient(), terminal = setupTerminal(query.data);
  useEffect(() => { if (terminal) void client.invalidateQueries({ queryKey: [...queryKeys.copy.all] }); }, [terminal, client]);
  const passing = query.isError && isTransient(query.error);
  return { ...query,
    /** Retrying a passing failure: say so calmly, keep the stages. */
    retrying: !terminal && passing,
    /** A failure the dialog can't retry its way out of (a 4xx). */
    failure: query.isError && !passing ? query.error : null };
}
