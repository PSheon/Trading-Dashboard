// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { LiveCopyActions } from '@/components/copy/live-copy-actions';
import { LiveCopyProgress } from '@/components/copy/live-copy-setup-dialogs';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveSetupMessages } from '@/i18n/live-setup';
import { liveSettings } from './copy-live-fixtures';

const state = vi.hoisted(() => ({ setup: null as unknown, saved: false, request: vi.fn(), cancel: vi.fn() }));
const action = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
vi.mock('@/lib/copy-live-setup', () => ({
  useLiveCopyDeployment: () => ({ network: 'testnet', setupAbort: true }),
  useLiveCopySetup: () => ({ data: state.setup, retrying: false, failure: null }),
  useLiveCopySetupActions: () => ({ pause: action(), resume: action(), edit: action(), renew: action(), topUp: action(), restart: action(),
    cancel: { ...action(), mutate: state.cancel }, confirm: action(), hasSavedAbortIntent: () => state.saved }),
  setupTerminal: (setup: LiveCopySetup) => ['running', 'failed', 'expired', 'cancelled'].includes(setup.stage),
}));
vi.mock('@/lib/copy-live-setup-abort', () => ({ useLiveSetupAbort: () => ({ available: true, progress: null, loading: false, requesting: false,
  error: null, request: state.request, refresh: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/portfolio', useSearchParams: () => new URLSearchParams() }));
const base: LiveCopySetup = { id: '11111111-1111-4111-8111-111111111111', kind: 'start', strategyId: 7, accountId: 'acct', leaderAddress: `0x${'44'.repeat(20)}`,
  sourceNetwork: 'testnet', budgetUsd: '50', settings: liveSettings, stage: 'provisioning', issue: null, consent: null, funding: null, mandateId: null,
  setupDeadline: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' };

const originalFunding: NonNullable<LiveCopySetup['funding']> = {
  id: '22222222-2222-4222-8222-222222222222', accountId: 'acct', strategyId: 7, network: 'testnet',
  address: `0x${'11'.repeat(20)}`, destination: `0x${'22'.repeat(20)}`, amount: '50', nonce: 7,
  status: 'prepared', canCancel: true, transactionHash: null, creditedAmount: null, fee: null,
  direction: 'to_account', createdAt: base.createdAt, updatedAt: base.updatedAt,
};
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.setup = base; state.saved = false; state.request.mockReset(); state.cancel.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find(b => b.textContent === label);
const provider = (child: ReactNode) => <I18nProvider locale="en" messages={catalogs.en}>{child}</I18nProvider>;

it('the real Continue setup entry propagates explicit abort intent to the card before closing an uncertain request', async () => {
  state.setup = { ...base, funding: originalFunding };
  await act(async () => root.render(provider(<LiveCopyActions item={{ strategyId: 7, network: 'testnet', stage: 'needs_deposit', status: 'active',
    accountId: 'acct', setup: { ...base, fundingStatus: 'prepared' }, mandate: null, pendingTransfer: null } as never} strategy={null} />)));
  expect(button(liveSetupMessages.en.topUp, container)).toBeTruthy();
  await act(async () => button(liveSetupMessages.en.continueSetup, container)!.click());
  await act(async () => button(catalogs.en.liveCopyUi.abortAction, document.querySelector('[role="dialog"]')!)!.click());
  expect(state.request).not.toHaveBeenCalled();
  await act(async () => button(catalogs.en.liveCopyUi.abortAction, document.querySelector('[role="dialog"]')!)!.click());
  expect(state.request).toHaveBeenCalledOnce();
  await act(async () => button(catalogs.en.common.close, document.querySelector('[role="dialog"]')!)!.click());
  expect(button(liveSetupMessages.en.topUp, container)).toBeUndefined();
  expect(button(liveSetupMessages.en.restart, container)).toBeUndefined();
  expect(button(catalogs.en.liveCopyUi.abortRefresh, container)).toBeTruthy();
});

it('a reloaded saved request opens original abort progress without handing an unaccepted server consent back to signing', async () => {
  state.saved = true;
  state.setup = { ...base, stage: 'awaiting_consent', abortRequested: false, consent: { nonce: 7 } };
  const onConsent = vi.fn();
  await act(async () => root.render(provider(<LiveCopyProgress setupId={base.id} open onOpenChange={() => {}} onConsent={onConsent} />)));
  expect(onConsent).not.toHaveBeenCalled(); expect(state.request).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="live-copy-stages"]')).toBeNull();
  expect(document.body.textContent).toContain(catalogs.en.liveCopyUi.abortConfirm);
});


it.each(['provisioning', 'failed', 'expired', 'cancelled'] as const)('an unfunded %s start keeps ordinary setup controls without offering an unfulfillable refund', async stage => {
  state.setup = { ...base, stage, accountId: null };
  await act(async () => root.render(provider(<LiveCopyProgress setupId={base.id} open onOpenChange={() => {}} onRetry={() => {}} />)));
  expect(button(catalogs.en.liveCopyUi.abortAction)).toBeUndefined();
  expect(state.request).not.toHaveBeenCalled();
  if (stage !== 'cancelled') {
    expect(button(liveSetupMessages.en.restart)).toBeTruthy();
    await act(async () => button(liveSetupMessages.en.cancelSetup)!.click());
    expect(state.cancel).toHaveBeenCalledWith(base.id, expect.objectContaining({ onError: expect.any(Function) }));
  } else expect(button(liveSetupMessages.en.cancelSetup)).toBeUndefined();
});

it('the actual card also excludes a new abort for an original setup with no funding operation', async () => {
  await act(async () => root.render(provider(<LiveCopyActions item={{ strategyId: 7, network: 'testnet', stage: 'needs_deposit', status: 'active',
    accountId: 'acct', setup: { ...base, fundingStatus: null }, mandate: null, pendingTransfer: null } as never} strategy={null} />)));
  expect(button(catalogs.en.liveCopyUi.abortAction, container)).toBeUndefined();
  expect(button(liveSetupMessages.en.continueSetup, container)).toBeTruthy();
  expect(state.request).not.toHaveBeenCalled();
});

it.each(['prepared', 'unknown', 'accepted', 'credited'] as const)('an original %s funding operation retains explicit safe abort, including delayed credit', async status => {
  state.setup = { ...base, stage: 'failed', funding: { ...originalFunding, status } };
  await act(async () => root.render(provider(<LiveCopyProgress setupId={base.id} open onOpenChange={() => {}} />)));
  await act(async () => button(catalogs.en.liveCopyUi.abortAction)!.click());
  expect(state.request).not.toHaveBeenCalled();
  await act(async () => button(catalogs.en.liveCopyUi.abortAction)!.click());
  expect(state.request).toHaveBeenCalledOnce();
});

it.each(['edit', 'renewal'] as const)('an unfunded pending %s retains cancellation of its pending generation', async kind => {
  state.setup = { ...base, kind };
  await act(async () => root.render(provider(<LiveCopyProgress setupId={base.id} open onOpenChange={() => {}} />)));
  await act(async () => button(catalogs.en.liveCopyUi.abortChange)!.click());
  expect(document.querySelector('[data-testid="live-copy-stages"]')).toBeNull();
  expect(state.request).not.toHaveBeenCalled();
});

it('an already requested unfunded abort always resumes its original progress without a new request or consent', async () => {
  state.setup = { ...base, stage: 'awaiting_consent', abortRequested: true, consent: { nonce: 7 } };
  const onConsent = vi.fn();
  await act(async () => root.render(provider(<LiveCopyProgress setupId={base.id} open onOpenChange={() => {}} onConsent={onConsent} />)));
  expect(onConsent).not.toHaveBeenCalled(); expect(state.request).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="live-copy-stages"]')).toBeNull();
  expect(document.body.textContent).toContain(catalogs.en.liveCopyUi.abortConfirm);
});
