'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { liveCopyMandateSchema, liveCopyOverviewSchema, liveCopySetupConsentTypedData, liveCopySetupSchema, LIVE_SETUP_TERMINAL, usdSendTypedData, WALLET_NETWORKS,
  type CopyStrategySettings, type LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { api, ApiError, sessionKey } from './api';
import { useAuth } from './auth';
import { isTransient, retryAfter } from './copy-error-text';
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

/** Whether this deployment runs testnet copies (`capabilities.automaticExecution`). */
export function useLiveCopyAvailable(): boolean {
  const auth = useAuth(), enabled = liveCopyEnabled(auth);
  // Once a minute at most: the site-wide 10 s poll would otherwise reread
  // it on every trader page (web audit L5).
  const query = useQuery({ queryKey: [...queryKeys.copy.all, 'live-capabilities', auth.identity, sessionKey()], enabled, staleTime: 60_000, refetchInterval: 60_000, retry: false,
    queryFn: async ({ signal }) => liveCopyOverviewSchema.parse(await api.get(ROOT, signal)).capabilities });
  return enabled && query.data?.automaticExecution === true;
}

export const setupTerminal = (setup: Pick<LiveCopySetup, 'stage'> | null | undefined) => Boolean(setup && LIVE_SETUP_TERMINAL.includes(setup.stage));

export interface StartLiveCopyInput { leader: string; budgetUsd: string; settings: CopyStrategySettings }

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
 * `edit:<id>:<terms>`, `renew:<id>`, `topup:…`), for the page's life: a
 * remounted panel or row retries the same terms with the same key and the
 * server answers with the same setup; changed terms (the sheet dismissed,
 * the amount changed) are a new attempt with a new key, never a 409
 * "payload changed" or the old setup's terms on the sheet.
 * Scoped to the signed-in identity and session; another session never
 * reuses them (they are dropped when it changes).
 */
const setupKeys = new Map<string, string>();
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
  const keys = () => scopedKeys(liveSetupScope(latest.current.identity));
  const keyFor = (name: string) => { const map = keys(); let value = map.get(name); if (!value) { value = crypto.randomUUID(); map.set(name, value); } return value; };
  const forget = (name: string) => keys().delete(name);
  /** The attempt names a setup was made under (exact names only). */
  const startName = (leader: string, budgetUsd: string, settings: unknown) => `start:${leader}:${termsFingerprint({ budgetUsd, settings })}`;
  const editName = (strategyId: number, budgetUsd: string, settings: unknown) => `edit:${strategyId}:${termsFingerprint({ budgetUsd, settings })}`;
  const namesOf = (setup: Pick<LiveCopySetup, 'kind' | 'strategyId' | 'leaderAddress' | 'budgetUsd' | 'settings'>) => setup.kind === 'start' ? [startName(setup.leaderAddress, setup.budgetUsd, setup.settings)]
    : [editName(setup.strategyId, setup.budgetUsd, setup.settings), `renew:${setup.strategyId}`];
  const refresh = () => { void client.invalidateQueries({ queryKey: [...queryKeys.copy.all] }); };
  /** The progress dialog opens on what the server just answered: a first
   * poll that fails in passing still shows the stages (never an empty list). */
  const seed = (setup: LiveCopySetup) => { client.setQueryData(liveSetupKey(setup.id, latest.current.identity), setup); return setup; };
  const owner = () => {
    const current = latest.current, wallet = current.wallet, identity = current.identity, session = sessionKey();
    if (!wallet || !liveCopyEnabled(current)) throw new Error('owner_wallet_unavailable');
    return { wallet, assertSame: () => { if (latest.current.identity !== identity || latest.current.wallet?.address !== wallet.address || sessionKey() !== session) throw new Error('live_session_changed'); } };
  };
  /** Preparation is idempotent: while the wallet or agent is still being
   * made, the same request is sent again (a few seconds at most). */
  const prepare = async (name: string, send: (key: string) => Promise<unknown>) => {
    const key = keyFor(name);
    for (let attempt = 0; ; attempt++) {
      const setup = seed(liveCopySetupSchema.parse(await send(key)));
      if (setup.stage !== 'provisioning' || attempt >= 8) return setup;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  };
  const start = useMutation({
    mutationFn: async (input: StartLiveCopyInput) => prepare(startName(input.leader, input.budgetUsd, input.settings), key => api.post(`${ROOT}/setups`, { idempotencyKey: key, leader: input.leader, sourceNetwork: 'mainnet', budgetUsd: input.budgetUsd, settings: input.settings })),
  });
  const edit = useMutation({
    mutationFn: async ({ strategyId, budgetUsd, settings }: { strategyId: number; budgetUsd: string; settings: CopyStrategySettings }) =>
      prepare(editName(strategyId, budgetUsd, settings), key => api.patch(`${ROOT}/strategies/${strategyId}`, { idempotencyKey: key, budgetUsd, settings })),
  });
  const renew = useMutation({
    mutationFn: async ({ strategyId }: { strategyId: number }) => prepare(`renew:${strategyId}`, key => api.post(`${ROOT}/strategies/${strategyId}/renew`, { idempotencyKey: key })),
  });
  /** What confirm is waiting for, for the sheet to say (adding the worker signer can take a while). */
  const [confirmPhase, setConfirmPhase] = useState<'attaching' | null>(null);
  const confirm = useMutation({
    mutationFn: async (setup: LiveCopySetup) => {
      const { wallet, assertSame } = owner();
      const body = await signSetup(setup, (data, options) => wallet.signTypedData(data, options));
      assertSame();
      setConfirmPhase('attaching');
      // Declined or timed out: throws, so no /confirm is sent and nothing is deposited.
      try {
        await attachWorker(setup, wallet, ATTACH_WORKER_TIMEOUT_MS,
          accountId => void api.post(`/me/copy/execution-wallets/${encodeURIComponent(accountId)}/reconcile`, {}).catch(() => undefined));
      } finally { setConfirmPhase(null); }
      assertSame();
      const result = seed(liveCopySetupSchema.parse(await api.post(`${ROOT}/setups/${encodeURIComponent(setup.id)}/confirm`, body)));
      for (const name of namesOf(setup)) forget(name);
      refresh(); return result;
    },
  });
  /** Before its consent, or once it failed or expired (a start that never
   * ran stops; a deposit that arrived is returned from the portfolio). */
  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const result = liveCopySetupSchema.parse(await api.post(`${ROOT}/setups/${encodeURIComponent(id)}/cancel`, {}));
      for (const name of namesOf(result)) forget(name);
      refresh(); return result;
    },
  });
  /** The same terms again under a new key: a fresh consent challenge. */
  const restart = useMutation({
    mutationFn: async (setupOrId: LiveCopySetup | string) => {
      const setup = typeof setupOrId === 'string' ? liveCopySetupSchema.parse(await api.get(`${ROOT}/setups/${encodeURIComponent(setupOrId)}`)) : setupOrId;
      for (const name of namesOf(setup)) forget(name);
      const next = setup.kind === 'start' ? await start.mutateAsync({ leader: setup.leaderAddress, budgetUsd: setup.budgetUsd, settings: setup.settings })
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
      const reserved = await api.post<{ id: string; destination: string; amount: string; nonce: number; status: string }>(`/me/copy/execution-wallets/${encodeURIComponent(accountId)}/funding`, { idempotencyKey: keyFor(name), amount });
      // The same attempt again (this key): already sent, or refused (an error, not a quiet close).
      if (reserved.status !== 'prepared') {
        forget(name); refresh();
        if (reserved.status === 'rejected' || reserved.status === 'cancelled') throw new ApiError(409, 'The deposit was refused', { code: 'setup_funding_rejected' });
        return reserved;
      }
      const signature = await wallet.signTypedData(usdSendTypedData(WALLET_NETWORKS.testnet, reserved.destination, reserved.amount, reserved.nonce) as unknown as Eip712TypedData, { silent: true });
      assertSame();
      await api.post(`/me/copy/funding/${encodeURIComponent(reserved.id)}/broadcast`, {});
      const result = await api.post(`/me/copy/funding/${encodeURIComponent(reserved.id)}/submit`, { signature });
      forget(name); refresh(); return result;
    },
  });
  return { start, edit, renew, confirm, confirmPhase, cancel, restart, resume, pause, topUp };
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
