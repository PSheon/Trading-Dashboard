// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { LiveCopyProgress } from '@/components/copy/live-copy-setup-dialogs';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveSetupMessages } from '@/i18n/live-setup';
import { copyErrorMessages } from '@/i18n/copy-errors';
import { ApiError } from '@/lib/api';

/**
 * The progress dialog off the happy path (logic review 2026-10-06 §A): a
 * setup still waiting for its consent goes back to the confirm sheet; one
 * whose consent lapsed, or that failed or expired, offers 重新開始 and
 * 取消設定 instead of spinning forever.
 */
const state = vi.hoisted(() => ({ setup: undefined as unknown, cancel: vi.fn(), retrying: false, failure: null as unknown }));
vi.mock('@/lib/copy-live-setup', async () => ({
  ...(await vi.importActual<typeof import('@/lib/copy-live-setup')>('@/lib/copy-live-setup')),
  useLiveCopySetup: () => ({ data: state.setup, isError: Boolean(state.failure), walletError: null, retrying: state.retrying, failure: state.failure }),
  useLiveCopySetupActions: () => ({ cancel: { mutate: state.cancel, isPending: false } }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/zh-TW/trader', useSearchParams: () => new URLSearchParams() }));

const zh = liveSetupMessages['zh-TW'];
const now = Date.now();
const consent = { kind: 'start', setupId: '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', nonce: now } as unknown as LiveCopySetup['consent'];
function setup(stage: LiveCopySetup['stage'], extra: Partial<LiveCopySetup> = {}): LiveCopySetup {
  return { id: '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', kind: 'start', strategyId: 7, accountId: 'acct', leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'mainnet', budgetUsd: '150',
    settings: { direction: 'same', sizingMode: 'ratio', perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' }, stage, issue: null, signer: null, consent: null,
    funding: null, pendingSignature: null, mandateId: null, setupDeadline: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), ...extra };
}

let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); state.retrying = false; state.failure = null; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function open(props: { onRetry?: (setup: LiveCopySetup) => void; onConsent?: (setup: LiveCopySetup) => void } = {}) {
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}><LiveCopyProgress setupId="0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c" open onOpenChange={() => {}} {...props} /></I18nProvider>));
}
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label);

it('a setup still waiting for its consent is handed back to the confirm sheet, once', async () => {
  const onConsent = vi.fn();
  state.setup = setup('awaiting_consent', { consent });
  await open({ onConsent });
  await open({ onConsent });
  expect(onConsent).toHaveBeenCalledExactlyOnceWith(state.setup);
});

it('a consent that lapsed offers 重新開始 and 取消設定, and no spinner', async () => {
  const onRetry = vi.fn();
  state.setup = setup('awaiting_consent');
  await open({ onRetry });
  expect(document.body.textContent).toContain(zh.consentLapsed);
  expect(document.querySelector('[data-testid="live-copy-stages"] .animate-spin')).toBeNull();
  await act(async () => button(zh.restart)!.click());
  expect(onRetry).toHaveBeenCalledExactlyOnceWith(state.setup);
  await act(async () => button(zh.cancelSetup)!.click());
  expect(state.cancel).toHaveBeenCalledWith(setup('awaiting_consent').id, expect.anything());
});

it('a start that failed after its deposit arrived: 重新開始 / 取消設定, and the deposit stays to be returned', async () => {
  const onRetry = vi.fn();
  state.setup = setup('failed', { issue: 'setup_account_mode_failed', funding: { status: 'credited' } as LiveCopySetup['funding'] });
  await open({ onRetry });
  expect(document.body.textContent).toContain(zh.failed);
  expect(document.body.textContent).toContain(zh.errors.setup_account_mode_failed);
  expect(document.body.textContent).toContain(zh.depositStays);
  expect(button(zh.restart)).toBeTruthy();
  await act(async () => button(zh.cancelSetup)!.click());
  expect(state.cancel).toHaveBeenCalledTimes(1);
  // Expired: the same choices.
  state.setup = setup('expired', { issue: 'setup_expired' });
  await open({ onRetry });
  expect(button(zh.restart)).toBeTruthy(); expect(button(zh.cancelSetup)).toBeTruthy();
});

const extra = copyErrorMessages['zh-TW'];
const alert = () => document.querySelector('[role="alert"]');

it('a passing failure (busy, 5xx, the network) is a calm retrying line with the last stages, never 發生錯誤', async () => {
  state.setup = setup('funding_submitted', { signer: 'owner_session' });
  state.retrying = true;
  await open();
  expect(document.querySelector('[data-testid="live-copy-retrying"]')!.textContent).toBe(extra.retrying);
  expect(alert()).toBeNull();
  expect(document.body.textContent).not.toContain(zh.errors.generic);
  expect([...document.querySelectorAll('[data-testid="live-copy-stages"] li')].map(li => li.getAttribute('data-state'))).toEqual(['done', 'done', 'current', 'pending', 'pending', 'pending']);
});

it("a running setup's own wait says so calmly: busy Hyperliquid retries, other waits retry later", async () => {
  state.setup = setup('mode_set', { signer: 'worker_policy', issue: 'hyperliquid_busy' });
  await open();
  expect(document.querySelector('[data-testid="live-copy-retrying"]')!.textContent).toBe(extra.retrying);
  state.setup = setup('mode_set', { signer: 'worker_policy', issue: 'agent_verification_pending' });
  await open();
  expect(document.querySelector('[data-testid="live-copy-retrying"]')!.textContent).toBe(extra.stepRetrying);
  // Waiting for the credit has its own line, not a retry note.
  state.setup = setup('funding_submitted', { signer: 'worker_policy', issue: 'awaiting_credit' });
  await open();
  expect(document.querySelector('[data-testid="live-copy-retrying"]')).toBeNull();
  expect(document.body.textContent).toContain(zh.waitingCredit);
  expect(alert()).toBeNull();
});

it('a refusal for good says what it is, not the generic line', async () => {
  state.setup = setup('funding_submitted', { signer: 'owner_session' });
  state.failure = new ApiError(409, 'A stop is in progress for this copy', { code: 'live_stop_in_progress' });
  await open();
  expect(alert()!.textContent).toBe(extra.codes.live_stop_in_progress);
  state.failure = new ApiError(401, 'Unauthorized');
  await open();
  expect(alert()!.textContent).toBe(extra.signInAgain);
});

it('a setup still preparing its wallet offers 重新開始 and 取消設定 (it no longer spins with no way out)', async () => {
  const onRetry = vi.fn();
  state.setup = setup('provisioning', { issue: 'agent_preparation_pending' });
  await open({ onRetry });
  expect(document.body.textContent).toContain(zh.preparingHint);
  await act(async () => button(zh.restart)!.click());
  expect(onRetry).toHaveBeenCalledExactlyOnceWith(state.setup);
  await act(async () => button(zh.cancelSetup)!.click());
  expect(state.cancel).toHaveBeenCalledWith(state.setup && (state.setup as LiveCopySetup).id, expect.anything());
});

it("a deposit never seen credited by the deadline: the setup ended, and the dialog says where the money went", async () => {
  state.setup = setup('expired', { issue: 'setup_deposit_uncredited', funding: { status: 'accepted', amount: '150', destination: `0x${'22'.repeat(20)}` } as LiveCopySetup['funding'] });
  await open({ onRetry: vi.fn() });
  expect(alert()!.textContent).toBe(extra.depositUncredited.replace('{amount}', '150').replace('{address}', '0x2222…2222'));
  expect(button(zh.cancelSetup)).toBeTruthy();
});
