// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveCopySetupIntentSchema, type LiveCopySetup, type LiveCopySetupIntent } from '@trading-dashboard/shared/contracts';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveSetupMessages } from '@/i18n/live-setup';
import { LOCALES } from '@/i18n/config';
import { signSetup, useLiveCopySetup, useLiveCopySetupActions } from '@/lib/copy-live-setup';

const state = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn(), sign: vi.fn(), addSigners: vi.fn(), identity: 'owner@email', session: '1', address: `0x${'11'.repeat(20)}` as string | null }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: state.identity, wallet: { address: state.address, signTypedData: state.sign, addSigners: state.addSigners } }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/trader', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/api', async () => ({ ApiError: (await vi.importActual<typeof import('@/lib/api')>('@/lib/api')).ApiError, api: { get: state.get, post: state.post, patch: state.patch }, sessionKey: () => state.session }));

const now = Date.now();
function intent(kind: LiveCopySetupIntent['kind'] = 'start'): LiveCopySetupIntent {
  return liveCopySetupIntentSchema.parse({ kind, setupId: '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', userId: 1, ownerAddress: `0x${'11'.repeat(20)}`, ownerPrivyUserId: 'did:privy:owner',
    strategyId: 7, leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'mainnet', network: 'testnet', budgetUsd: '150', settingsDigest: 'a'.repeat(64), accountId: 'acct', accountAddress: `0x${'22'.repeat(20)}`,
    accountAbstraction: 'disabled', agentAddress: `0x${'33'.repeat(20)}`, agentPolicyId: 'policy', agentPolicyFingerprint: 'b'.repeat(64), workerQuorumId: 'worker', agentValidUntil: now + 30 * 86_400_000,
    builderAddress: null, builderMaxFeeTenthsOfBps: 0, sweepDestination: `0x${'11'.repeat(20)}`, masterPolicyId: 'master', masterPolicyFingerprint: 'c'.repeat(64),
    fundingOperationId: kind === 'start' ? '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f' : '', fundingNonce: kind === 'start' ? now - 10 : 0, fundingAmount: kind === 'start' ? '150' : '0',
    nonce: now, consentExpiresAt: now + 300_000, setupDeadline: now + 86_400_000 });
}
const settings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
function setup(kind: LiveCopySetupIntent['kind'] = 'start', stage: LiveCopySetup['stage'] = 'awaiting_consent'): LiveCopySetup {
  return { id: '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', kind, strategyId: 7, accountId: 'acct', leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'mainnet', budgetUsd: '150', settings, stage, issue: null,
    consent: stage === 'awaiting_consent' ? intent(kind) : null, funding: null, mandateId: null, setupDeadline: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
}

let root: Root, container: HTMLDivElement, client: QueryClient;
const probe: { current: ReturnType<typeof useLiveCopySetupActions> | null } = { current: null };
const progress: { current: ReturnType<typeof useLiveCopySetup> | null } = { current: null };
function Probe() { const value = useLiveCopySetupActions(); useLayoutEffect(() => { probe.current = value; }); return null; }
function ProgressProbe({ id }: { id: string }) { const value = useLiveCopySetup(id); useLayoutEffect(() => { progress.current = value; }); return null; }
// The idempotency keys live for the page (a module store): a fresh person per test.
let person = 0;
beforeEach(async () => {
  vi.clearAllMocks(); state.identity = `owner-${++person}@email`; state.session = '1'; state.address = `0x${'11'.repeat(20)}`;
  state.sign.mockImplementation(async () => `0x${'ab'.repeat(65)}`);
  state.addSigners.mockImplementation(async () => undefined);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Probe /></I18nProvider></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

async function renderActions() {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Probe /></I18nProvider></QueryClientProvider>));
}

it('waits for the original owner wallet before signing exactly one confirmation', async () => {
  state.address = null; await renderActions();
  state.post.mockResolvedValue(setup('start', 'funding_submitted'));
  let done: Promise<unknown>;
  await act(async () => { done = probe.current!.confirm.mutateAsync(setup()).catch(error => error); await new Promise(resolve => setTimeout(resolve, 20)); });
  const earlySignCount = state.sign.mock.calls.length;
  state.address = `0x${'11'.repeat(20)}`; await renderActions();
  let result: unknown;
  await act(async () => { result = await done!; });
  expect(earlySignCount).toBe(0);
  expect(result).toMatchObject({ stage: 'funding_submitted' });
  expect(state.sign).toHaveBeenCalledTimes(2);
  expect(state.addSigners).toHaveBeenCalledTimes(1);
  expect(state.post).toHaveBeenCalledTimes(1);
});

it('aborts wallet readiness waiting when the login session changes', async () => {
  state.address = null; await renderActions();
  state.post.mockResolvedValue(setup('start', 'funding_submitted'));
  let done: Promise<unknown>;
  await act(async () => { done = probe.current!.confirm.mutateAsync(setup()).catch(error => error); await new Promise(resolve => setTimeout(resolve, 20)); });
  state.session = 'replacement'; state.address = `0x${'11'.repeat(20)}`; await renderActions();
  let result: unknown;
  await act(async () => { result = await done!; });
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe('live_session_changed');
  expect(state.sign).not.toHaveBeenCalled();
  expect(state.addSigners).not.toHaveBeenCalled();
  expect(state.post).not.toHaveBeenCalled();
});

it('never confirms with a ready wallet different from the consented owner', async () => {
  state.address = `0x${'99'.repeat(20)}`; await renderActions();
  await act(async () => { await expect(probe.current!.confirm.mutateAsync(setup())).rejects.toThrow('live_session_changed'); });
  expect(state.sign).not.toHaveBeenCalled();
  expect(state.addSigners).not.toHaveBeenCalled();
  expect(state.post).not.toHaveBeenCalled();
});

it('wallet readiness has a bounded wait and cannot sign after the component leaves', async () => {
  state.address = null; await renderActions();
  let done: Promise<unknown>;
  await act(async () => { done = probe.current!.confirm.mutateAsync(setup()).catch(error => error); await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => root.render(null));
  state.address = `0x${'11'.repeat(20)}`;
  let result: unknown;
  await act(async () => { result = await done!; });
  expect((result as Error).message).toBe('live_session_changed');
  expect(state.sign).not.toHaveBeenCalled();
  expect(state.post).not.toHaveBeenCalled();
});

it('wallet readiness times out without signatures or a deposit request', async () => {
  vi.useFakeTimers();
  try {
    state.address = null; await renderActions();
    let done: Promise<unknown>;
    await act(async () => { done = probe.current!.confirm.mutateAsync(setup()).catch(error => error); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect((await done! as Error).message).toBe('owner_wallet_unavailable');
    expect(state.sign).not.toHaveBeenCalled();
    expect(state.addSigners).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it.each(['unmount', 'session'] as const)('does not sign the deposit after %s during the consent signature', async change => {
  let finishSign!: (signature: string) => void;
  state.sign.mockImplementationOnce(() => new Promise<string>(resolve => { finishSign = resolve; }));
  state.post.mockResolvedValue(setup('start', 'funding_submitted'));
  let done: Promise<unknown>;
  await act(async () => { done = probe.current!.confirm.mutateAsync(setup()).catch(error => error); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(state.sign).toHaveBeenCalledTimes(1);
  if (change === 'unmount') await act(async () => root.render(null));
  else { state.session = 'replacement'; await renderActions(); }
  let result: unknown;
  await act(async () => { finishSign(`0x${'ab'.repeat(65)}`); result = await done!; });
  expect((result as Error).message).toBe('live_session_changed');
  expect(state.sign).toHaveBeenCalledTimes(1);
  expect(state.addSigners).not.toHaveBeenCalled();
  expect(state.post).not.toHaveBeenCalled();
});

it('does not submit confirmation after unmount during addSigners', async () => {
  let finishAttach!: () => void;
  state.addSigners.mockImplementationOnce(() => new Promise<void>(resolve => { finishAttach = resolve; }));
  state.post.mockResolvedValue(setup('start', 'funding_submitted'));
  let done: Promise<unknown>;
  await act(async () => { done = probe.current!.confirm.mutateAsync(setup()).catch(error => error); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(state.addSigners).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  let result: unknown;
  await act(async () => { finishAttach(); result = await done!; });
  expect((result as Error).message).toBe('live_session_changed');
  expect(state.post).not.toHaveBeenCalled();
});

it('signs the setup consent and the deposit without Privy’s modal, and only those two', async () => {
  const sign = vi.fn(async () => `0x${'ab'.repeat(65)}`);
  const body = await signSetup(setup(), sign);
  expect(sign).toHaveBeenCalledTimes(2);
  const calls = sign.mock.calls as unknown as [{ primaryType: string; message: Record<string, unknown>; domain: { name: string } }, { silent: boolean }][];
  expect(calls[0]![0]).toMatchObject({ primaryType: 'CopyLiveSetupConsent', domain: { name: 'Copy Trading Setup' }, message: { budgetUsd: '150', masterPolicyId: 'master', kind: 'start' } });
  expect(calls[1]![0]).toMatchObject({ primaryType: 'HyperliquidTransaction:UsdSend', message: { destination: `0x${'22'.repeat(20)}`, amount: '150', hyperliquidChain: 'Testnet' } });
  expect(calls.every(([, options]) => options.silent === true)).toBe(true);
  expect(body).toEqual({ consentSignature: `0x${'ab'.repeat(65)}`, fundingSignature: `0x${'ab'.repeat(65)}` });
  // An edit or renewal deposits nothing: one signature.
  sign.mockClear();
  expect(await signSetup(setup('edit'), sign)).toEqual({ consentSignature: `0x${'ab'.repeat(65)}` });
  expect(sign).toHaveBeenCalledTimes(1);
  await expect(signSetup(setup('start', 'running'), sign)).rejects.toThrow('setup_consent_expired');
});

it('a retried start reuses its idempotency key, so the server answers with the same setup', async () => {
  state.post.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(setup());
  await act(async () => { await probe.current!.start.mutateAsync({ leader: `0x${'44'.repeat(20)}`, budgetUsd: '150', settings }).catch(() => undefined); });
  await act(async () => { await probe.current!.start.mutateAsync({ leader: `0x${'44'.repeat(20)}`, budgetUsd: '150', settings }); });
  const keys = state.post.mock.calls.map(([, body]) => (body as { idempotencyKey: string }).idempotencyKey);
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  expect(state.post.mock.calls[0]![0]).toBe('/me/copy/live/setups');
  expect(state.post.mock.calls[0]![1]).toMatchObject({ sourceNetwork: 'mainnet', budgetUsd: '150', settings });
});

it('confirm sends both signatures once; a session change while signing aborts before anything is sent', async () => {
  state.post.mockResolvedValue(setup('start', 'funding_submitted'));
  await act(async () => { await probe.current!.confirm.mutateAsync(setup()); });
  // The worker added under the consented policy, by this browser, before confirm (the one signing model).
  expect(state.addSigners).toHaveBeenCalledExactlyOnceWith(`0x${'22'.repeat(20)}`, [{ signerId: 'worker', policyIds: ['master'] }]);
  expect(state.addSigners.mock.invocationCallOrder[0]!).toBeLessThan(state.post.mock.invocationCallOrder[0]!);
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.post.mock.calls[0]![0]).toBe('/me/copy/live/setups/0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c/confirm');
  expect(Object.keys(state.post.mock.calls[0]![1] as object).sort()).toEqual(['consentSignature', 'fundingSignature']);
  state.post.mockClear();
  state.sign.mockImplementation(async () => { state.session = '2'; return `0x${'ab'.repeat(65)}`; });
  let error: unknown;
  await act(async () => { await probe.current!.confirm.mutateAsync(setup()).catch(e => { error = e; }); });
  expect((error as Error).message).toBe('live_session_changed');
  expect(state.post).not.toHaveBeenCalled();
});

it('every language has every one-click text', () => {
  const keys = (value: unknown, prefix = ''): string[] => value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix];
  const english = keys(liveSetupMessages.en).sort();
  for (const locale of LOCALES) {
    expect(keys(liveSetupMessages[locale]).sort()).toEqual(english);
    for (const text of Object.values(liveSetupMessages[locale])) if (typeof text === 'string') expect(text.trim()).not.toBe('');
  }
});

async function openProgress() {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Probe /><ProgressProbe id={setup().id} /></I18nProvider></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

it("the progress dialog only reads: the worker runs and signs every step, nothing is signed or sent from the browser", async () => {
  state.get.mockResolvedValue(setup('start', 'funded'));
  await openProgress();
  expect(progress.current!.data?.stage).toBe('funded');
  expect(state.get).toHaveBeenCalledWith('/me/copy/live/setups/0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', expect.anything());
  expect(state.post).not.toHaveBeenCalled(); expect(state.sign).not.toHaveBeenCalled(); expect(state.addSigners).not.toHaveBeenCalled();
  expect(progress.current).not.toHaveProperty('walletError');
});

it('addSigners declined: confirm stops with worker_signer_missing, no /confirm is sent (nothing deposited); allowing it on a retry confirms', async () => {
  state.addSigners.mockRejectedValueOnce(new Error('User rejected the request'));
  state.post.mockResolvedValue(setup('start', 'funding_submitted'));
  let error: unknown;
  await act(async () => { await probe.current!.confirm.mutateAsync(setup()).catch(e => { error = e; }); });
  expect((error as Error).message).toBe('worker_signer_missing');
  expect(state.post).not.toHaveBeenCalled();
  // Retried while the consent lasts: allowed this time.
  await act(async () => { await probe.current!.confirm.mutateAsync(setup()); });
  expect(state.addSigners).toHaveBeenCalledTimes(2);
  expect(state.post).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\/confirm$/), expect.objectContaining({ fundingSignature: expect.any(String) }));
  // A start with no policy bound can't go on either; an edit adds nothing and confirms.
  state.post.mockClear(); state.addSigners.mockClear();
  await act(async () => { await probe.current!.confirm.mutateAsync({ ...setup(), consent: { ...intent(), masterPolicyId: '', masterPolicyFingerprint: '' } }).catch(e => { error = e; }); });
  expect((error as Error).message).toBe('worker_signer_missing'); expect(state.post).not.toHaveBeenCalled();
  await act(async () => { await probe.current!.confirm.mutateAsync(setup('edit')); });
  expect(state.addSigners).not.toHaveBeenCalled(); expect(state.post).toHaveBeenCalledTimes(1);
});

const leader = `0x${'44'.repeat(20)}`;
const keyOf = (call: unknown[]) => (call[1] as { idempotencyKey: string }).idempotencyKey;
async function remount() {
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Probe /></I18nProvider></QueryClientProvider>));
}

it('a remounted panel retries its start with the same key (the server answers with the same setup, not already_copying); another session never reuses it', async () => {
  state.post.mockResolvedValue(setup());
  await act(async () => { await probe.current!.start.mutateAsync({ leader, budgetUsd: '150', settings }); });
  await remount();
  await act(async () => { await probe.current!.start.mutateAsync({ leader, budgetUsd: '150', settings }); });
  expect(keyOf(state.post.mock.calls[1]!)).toBe(keyOf(state.post.mock.calls[0]!));
  state.session = '2'; await remount();
  await act(async () => { await probe.current!.start.mutateAsync({ leader, budgetUsd: '150', settings }); });
  expect(keyOf(state.post.mock.calls[2]!)).not.toBe(keyOf(state.post.mock.calls[0]!));
});

it("confirming one setup forgets exactly its own key: copy 12's confirm keeps copy 112's edit and another trader's start", async () => {
  state.patch.mockResolvedValue(setup('edit'));
  state.post.mockResolvedValue(setup());
  await act(async () => { await probe.current!.edit.mutateAsync({ strategyId: 112, budgetUsd: '150', settings }); });
  await act(async () => { await probe.current!.start.mutateAsync({ leader: `0x${'55'.repeat(20)}`, budgetUsd: '150', settings }); });
  state.post.mockResolvedValue({ ...setup('edit', 'running') });
  await act(async () => { await probe.current!.confirm.mutateAsync({ ...setup('edit'), strategyId: 12 }); });
  await act(async () => { await probe.current!.edit.mutateAsync({ strategyId: 112, budgetUsd: '150', settings }); });
  expect(keyOf(state.patch.mock.calls[1]!)).toBe(keyOf(state.patch.mock.calls[0]!));
  state.post.mockClear(); state.post.mockResolvedValue(setup());
  await act(async () => { await probe.current!.start.mutateAsync({ leader: `0x${'55'.repeat(20)}`, budgetUsd: '150', settings }); });
  const starts = state.post.mock.calls.filter(([path]) => path === '/me/copy/live/setups');
  expect(starts).toHaveLength(1);
});

it('restart begins an ended setup again with the same terms under a new key; cancel ends it', async () => {
  state.post.mockResolvedValue(setup());
  await act(async () => { await probe.current!.start.mutateAsync({ leader, budgetUsd: '150', settings }); });
  const failed = { ...setup('start', 'failed'), issue: 'setup_account_mode_failed' };
  let next: LiveCopySetup | undefined;
  await act(async () => { next = await probe.current!.restart.mutateAsync(failed); });
  const [first, second] = state.post.mock.calls;
  expect(second![0]).toBe('/me/copy/live/setups');
  expect(second![1]).toMatchObject({ leader, budgetUsd: '150', settings });
  expect(keyOf(second!)).not.toBe(keyOf(first!));
  expect(next!.stage).toBe('awaiting_consent');
  // By id (the portfolio row): read first.
  state.get.mockResolvedValueOnce(failed);
  await act(async () => { await probe.current!.restart.mutateAsync(failed.id); });
  expect(state.get).toHaveBeenCalledWith(`/me/copy/live/setups/${failed.id}`);
  state.post.mockResolvedValueOnce({ ...failed, stage: 'cancelled' });
  await act(async () => { await probe.current!.cancel.mutateAsync(failed.id); });
  expect(state.post).toHaveBeenLastCalledWith(`/me/copy/live/setups/${failed.id}/cancel`, {});
});

it('stops polling a setup the api refuses for good (signed out, not found), and keeps polling through a passing failure', async () => {
  const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    state.get.mockRejectedValue(new ApiError(404, 'Setup not found', { code: 'not_found' }));
    await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Probe /><ProgressProbe id={setup().id} /></I18nProvider></QueryClientProvider>));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(state.get).toHaveBeenCalledTimes(1);
    expect(progress.current!.isError).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("Privy never answering the signer request can't hold confirm: after 20 s it stops with worker_signer_missing, nothing sent, and the sheet can say what it waits for", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    state.addSigners.mockImplementation(() => new Promise(() => undefined));
    state.post.mockResolvedValue(setup('start', 'funding_submitted'));
    let error: unknown;
    const confirming = act(async () => { await probe.current!.confirm.mutateAsync(setup()).catch(e => { error = e; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(probe.current!.confirmPhase).toBe('attaching');
    expect(state.post).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await confirming;
    expect((error as Error).message).toBe('worker_signer_missing');
    expect(state.post).not.toHaveBeenCalled();
    expect(probe.current!.confirmPhase).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("the signer landing after confirm gave up is recorded at once: the browser asks the api to reconcile the copy wallet, so confirming again finds it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let land!: () => void;
    state.addSigners.mockImplementation(() => new Promise<void>(resolve => { land = resolve; }));
    state.post.mockResolvedValue(setup('start', 'funding_submitted'));
    const confirming = act(async () => { await probe.current!.confirm.mutateAsync(setup()).catch(() => undefined); });
    await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
    await confirming;
    expect(state.post).not.toHaveBeenCalled();
    // Privy finally answers: one reconcile of exactly this copy wallet.
    await act(async () => { land(); await vi.advanceTimersByTimeAsync(0); });
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenLastCalledWith('/me/copy/execution-wallets/acct/reconcile', {});
  } finally { vi.useRealTimers(); }
});

it("a signer added in time, or refused, asks for no extra reconcile", async () => {
  state.post.mockResolvedValue(setup('start', 'funding_submitted'));
  await act(async () => { await probe.current!.confirm.mutateAsync(setup()); });
  state.addSigners.mockRejectedValueOnce(new Error('declined'));
  state.identity = `owner-${++person}@email`;
  await act(async () => { await probe.current!.confirm.mutateAsync(setup()).catch(() => undefined); });
  expect(state.post.mock.calls.map(([path]) => path).filter(path => String(path).endsWith('/reconcile'))).toEqual([]);
});

it("a passing poll failure (503 busy) keeps the last stages and retries after Retry-After", async () => {
  const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const running = setup('start', 'funding_submitted');
    state.get.mockResolvedValue(running);
    await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Probe /><ProgressProbe id={running.id} /></I18nProvider></QueryClientProvider>));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(progress.current!.data?.stage).toBe('funding_submitted');
    expect(progress.current!.isError).toBe(false);
    expect(progress.current!.retrying).toBe(false);
    expect(state.post).not.toHaveBeenCalled();
    // Then the read itself is refused in passing (Hyperliquid busy, Retry-After 30 s).
    state.get.mockRejectedValue(new ApiError(503, 'busy', { code: 'busy' }, 30_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    const calls = state.get.mock.calls.length;
    expect(progress.current!.data?.stage).toBe('funding_submitted');
    expect(progress.current!.retrying).toBe(true);
    expect(progress.current!.failure).toBeNull();
    // Not asked again before Retry-After.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(state.get.mock.calls.length).toBe(calls);
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(state.get.mock.calls.length).toBe(calls + 1);
  } finally { vi.useRealTimers(); }
});

it('a start or edit with changed terms is a new attempt with its own key; the same terms reuse theirs (the sheet dismissed, the amount changed)', async () => {
  state.post.mockResolvedValue(setup());
  const leader = `0x${'44'.repeat(20)}`;
  await act(async () => { await probe.current!.start.mutateAsync({ leader, budgetUsd: '150', settings }); });
  await act(async () => { await probe.current!.start.mutateAsync({ leader, budgetUsd: '200', settings }); });
  await act(async () => { await probe.current!.start.mutateAsync({ leader, budgetUsd: '150', settings: { ...settings, maxLeverage: 3 } }); });
  // The same terms, keys in another order (as the server's jsonb echoes them).
  await act(async () => { await probe.current!.start.mutateAsync({ leader, budgetUsd: '150', settings: { copyStartMode: 'delta', maxLeverage: 5, maxTotalExposureUsd: null, perTradeUsd: null, sizingMode: 'ratio', direction: 'same' } }); });
  const keys = state.post.mock.calls.map(([, body]) => (body as { idempotencyKey: string }).idempotencyKey);
  expect(new Set(keys.slice(0, 3)).size).toBe(3);
  expect(keys[3]).toBe(keys[0]);
  state.patch.mockResolvedValue(setup('edit'));
  await act(async () => { await probe.current!.edit.mutateAsync({ strategyId: 7, budgetUsd: '150', settings }); });
  await act(async () => { await probe.current!.edit.mutateAsync({ strategyId: 7, budgetUsd: '300', settings }); });
  const editKeys = state.patch.mock.calls.map(([, body]) => (body as { idempotencyKey: string }).idempotencyKey);
  expect(editKeys[0]).not.toBe(editKeys[1]);
});

it("a silent signature that never comes ends confirm with signing_timeout after 90 s (the sheet can close again)", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    state.sign.mockImplementation(() => new Promise(() => undefined));
    let failure: unknown = null;
    const confirming = act(async () => { await probe.current!.confirm.mutateAsync(setup()).catch((error: unknown) => { failure = error; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(89_000); });
    expect(failure).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await confirming;
    expect((failure as Error | null)?.message).toBe('signing_timeout');
    expect(probe.current!.confirm.isPending).toBe(false);
    expect(state.post).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("the progress dialog opens on the setup confirm just answered: a first poll that fails in passing still shows its stages", async () => {
  const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  const confirmed = setup('start', 'funding_submitted');
  state.post.mockResolvedValue(confirmed);
  await act(async () => { await probe.current!.confirm.mutateAsync(setup()); });
  state.get.mockRejectedValue(new ApiError(503, 'busy', { code: 'busy' }, 30_000));
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Probe /><ProgressProbe id={confirmed.id} /></I18nProvider></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(progress.current!.data?.stage).toBe('funding_submitted');
  expect(progress.current!.retrying).toBe(true);
  expect(progress.current!.failure).toBeNull();
});
