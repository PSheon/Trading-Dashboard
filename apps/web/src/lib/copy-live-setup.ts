'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { liveCopyMandateSchema, liveCopyOverviewSchema, liveCopySetupConsentTypedData, liveCopySetupSchema, LIVE_SETUP_TERMINAL, usdSendTypedData, WALLET_NETWORKS,
  type CopyStrategySettings, type LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { api, ApiError, sessionKey } from './api';
import { useAuth } from './auth';
import { masterActionErrorCode, signMasterAction } from './copy-master-action';
import { FIXTURE_WALLET_ADDRESS } from './fixture-signer';
import { queryKeys } from './query-keys';
import type { Eip712TypedData } from './wallet-signer';

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
  const query = useQuery({ queryKey: [...queryKeys.copy.all, 'live-capabilities', auth.identity, sessionKey()], enabled, staleTime: 60_000, retry: false,
    queryFn: async ({ signal }) => liveCopyOverviewSchema.parse(await api.get(ROOT, signal)).capabilities });
  return enabled && query.data?.automaticExecution === true;
}

export const setupTerminal = (setup: Pick<LiveCopySetup, 'stage'> | null | undefined) => Boolean(setup && LIVE_SETUP_TERMINAL.includes(setup.stage));

export interface StartLiveCopyInput { leader: string; budgetUsd: string; settings: CopyStrategySettings }

/** The setup consent and the deposit, signed without Privy's modal: called
 * only from Orbie's confirm sheet, which lists every term (decision 1). */
export async function signSetup(setup: LiveCopySetup, sign: (data: Eip712TypedData, options: { silent: boolean }) => Promise<string>) {
  if (!setup.consent) throw new Error('setup_consent_expired');
  const consent = setup.consent;
  const consentSignature = await sign(liveCopySetupConsentTypedData(consent) as unknown as Eip712TypedData, { silent: true });
  const fundingSignature = consent.kind === 'start'
    ? await sign(usdSendTypedData(WALLET_NETWORKS.testnet, consent.accountAddress, consent.fundingAmount, consent.fundingNonce) as unknown as Eip712TypedData, { silent: true }) : undefined;
  return { consentSignature, ...(fundingSignature ? { fundingSignature } : {}) };
}

/**
 * One-click start, edit and renewal (docs/one-click-copy-plan-2026-10-05.md):
 * `start` prepares the setup and returns its consent challenge (one key per
 * attempt, reused by a retry so the server answers with the same setup);
 * `confirm` signs the consent and the deposit silently and sends them.
 * A session change between the two aborts.
 */
export function useLiveCopySetupActions() {
  const auth = useAuth(), client = useQueryClient();
  // The session as it is now (a sign-in or account switch mid-flow aborts).
  const latest = useRef(auth);
  useLayoutEffect(() => { latest.current = auth; });
  const keys = useRef(new Map<string, string>());
  const keyFor = (name: string) => { let value = keys.current.get(name); if (!value) { value = crypto.randomUUID(); keys.current.set(name, value); } return value; };
  const forget = (name: string) => keys.current.delete(name);
  const refresh = () => { void client.invalidateQueries({ queryKey: [...queryKeys.copy.all] }); };
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
      const setup = liveCopySetupSchema.parse(await send(key));
      if (setup.stage !== 'provisioning' || attempt >= 8) return setup;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  };
  const start = useMutation({
    mutationFn: async (input: StartLiveCopyInput) => prepare(`start:${input.leader}`, key => api.post(`${ROOT}/setups`, { idempotencyKey: key, leader: input.leader, sourceNetwork: 'mainnet', budgetUsd: input.budgetUsd, settings: input.settings })),
  });
  const edit = useMutation({
    mutationFn: async ({ strategyId, budgetUsd, settings }: { strategyId: number; budgetUsd: string; settings: CopyStrategySettings }) =>
      prepare(`edit:${strategyId}`, key => api.patch(`${ROOT}/strategies/${strategyId}`, { idempotencyKey: key, budgetUsd, settings })),
  });
  const renew = useMutation({
    mutationFn: async ({ strategyId }: { strategyId: number }) => prepare(`renew:${strategyId}`, key => api.post(`${ROOT}/strategies/${strategyId}/renew`, { idempotencyKey: key })),
  });
  const confirm = useMutation({
    mutationFn: async (setup: LiveCopySetup) => {
      const { wallet, assertSame } = owner();
      const body = await signSetup(setup, (data, options) => wallet.signTypedData(data, options));
      assertSame();
      const result = liveCopySetupSchema.parse(await api.post(`${ROOT}/setups/${encodeURIComponent(setup.id)}/confirm`, body));
      for (const name of [...keys.current.keys()]) if (name.endsWith(String(setup.strategyId)) || name.startsWith('start:')) forget(name);
      refresh(); return result;
    },
  });
  const cancel = useMutation({
    mutationFn: async (id: string) => { const result = liveCopySetupSchema.parse(await api.post(`${ROOT}/setups/${encodeURIComponent(id)}/cancel`, {})); keys.current.clear(); refresh(); return result; },
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
      if (reserved.status !== 'prepared') { forget(name); refresh(); return reserved; }
      const signature = await wallet.signTypedData(usdSendTypedData(WALLET_NETWORKS.testnet, reserved.destination, reserved.amount, reserved.nonce) as unknown as Eip712TypedData, { silent: true });
      assertSame();
      await api.post(`/me/copy/funding/${encodeURIComponent(reserved.id)}/broadcast`, {});
      const result = await api.post(`/me/copy/funding/${encodeURIComponent(reserved.id)}/submit`, { signature });
      forget(name); refresh(); return result;
    },
  });
  return { start, edit, renew, confirm, cancel, resume, pause, topUp };
}

/** After a wallet error, how long the dialog waits before signing again. */
const SIGN_RETRY_MS = 10_000;
/** Server refusals of a signature that a fresh payload replaces (the next
 * poll brings it): no error to show. */
const RENEWED = new Set(['owner_signature_stale', 'owner_signature_expired', 'owner_signature_not_requested']);

/**
 * One setup, polled every 2 s until it finishes. A setup the owner's browser
 * signs (`owner_session`) is continued by this dialog: each poll asks the
 * server for the next step (`advance`), and when the server parks the copy
 * account's next signature (`pendingSignature`: the account mode, the agent
 * approval, the builder fee) the dialog signs exactly it with that copy
 * account, silently, and sends it back with its digest; no extra click. A
 * wallet error is shown (`walletError`) and signing is tried again a little
 * later while the dialog stays open.
 */
export function useLiveCopySetup(id: string | null) {
  const auth = useAuth(), enabled = Boolean(id) && liveCopyEnabled(auth);
  const advanceAt = useRef(0), signing = useRef<string | null>(null), retryAt = useRef(0);
  const latest = useRef(auth);
  useLayoutEffect(() => { latest.current = auth; });
  const [walletError, setWalletError] = useState<string | null>(null);
  const query = useQuery<LiveCopySetup>({
    queryKey: [...queryKeys.copy.all, 'live-setup', id, auth.identity, sessionKey()], enabled, retry: false, staleTime: 0,
    refetchInterval: q => setupTerminal(q.state.data) ? false : 2000,
    queryFn: async ({ signal }): Promise<LiveCopySetup> => {
      const read = liveCopySetupSchema.parse(await api.get(`${ROOT}/setups/${encodeURIComponent(id!)}`, signal));
      const path = `${ROOT}/setups/${encodeURIComponent(id!)}/advance`;
      const pending = read.signer === 'owner_session' ? read.pendingSignature : null;
      if (pending && signing.current !== pending.digest && Date.now() >= retryAt.current) {
        signing.current = pending.digest;
        try {
          const wallet = latest.current.wallet;
          if (!wallet) throw new Error('owner_wallet_unavailable');
          const signature = await signMasterAction(wallet, pending, { kind: pending.kind, account: pending.account });
          const result = liveCopySetupSchema.parse(await api.post(path, { digest: pending.digest, signature }));
          setWalletError(null); return result;
        } catch (error) {
          const code = error instanceof ApiError ? error.code : null;
          if (code && RENEWED.has(code)) return read;
          retryAt.current = Date.now() + SIGN_RETRY_MS;
          setWalletError(code ?? masterActionErrorCode(error));
          return read;
        } finally { signing.current = null; }
      }
      const driven = ['consented', 'funding_submitted', 'funded', 'mode_set', 'agent_active', 'builder_ready'].includes(read.stage);
      if (driven && !pending && read.signer === 'owner_session' && Date.now() >= advanceAt.current) {
        advanceAt.current = Date.now() + 3000;
        return liveCopySetupSchema.parse(await api.post(path, {}));
      }
      return read;
    },
  });
  const client = useQueryClient(), terminal = setupTerminal(query.data);
  useEffect(() => { if (terminal) void client.invalidateQueries({ queryKey: [...queryKeys.copy.all] }); }, [terminal, client]);
  return { ...query, walletError: terminal ? null : walletError };
}
