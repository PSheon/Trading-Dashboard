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
import { signSetup, useLiveCopySetupActions } from '@/lib/copy-live-setup';

const state = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn(), sign: vi.fn(), identity: 'owner@email', session: '1' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: state.identity, wallet: { address: `0x${'11'.repeat(20)}`, signTypedData: state.sign } }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/trader', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/api', () => ({ api: { get: state.get, post: state.post, patch: state.patch }, sessionKey: () => state.session }));

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
    signer: null, consent: stage === 'awaiting_consent' ? intent(kind) : null, funding: null, mandateId: null, setupDeadline: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
}

let root: Root, container: HTMLDivElement, client: QueryClient;
const probe: { current: ReturnType<typeof useLiveCopySetupActions> | null } = { current: null };
function Probe() { const value = useLiveCopySetupActions(); useLayoutEffect(() => { probe.current = value; }); return null; }
beforeEach(async () => {
  vi.clearAllMocks(); state.identity = 'owner@email'; state.session = '1';
  state.sign.mockImplementation(async () => `0x${'ab'.repeat(65)}`);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Probe /></I18nProvider></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

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
  state.post.mockResolvedValue({ ...setup('start', 'funding_submitted'), signer: 'worker_policy' });
  await act(async () => { await probe.current!.confirm.mutateAsync(setup()); });
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
