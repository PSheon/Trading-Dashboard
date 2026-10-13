// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveSetupMessages } from '@/i18n/live-setup';
import { LiveCopyActions } from '@/components/copy/live-copy-actions';

// 取消並退款: a confirmed start whose deposit awaits its credit is cancelled
// through POST setups/:id/cancel (the api moves it into the setup abort).
const state = vi.hoisted(() => ({ setupAbort: true, cancel: { isPending: false, mutate: (() => undefined) as unknown, mutateAsync: (async () => undefined) as unknown } }));
const action = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
vi.mock('@/lib/copy-live-setup', () => ({
  useLiveCopyDeployment: () => ({ network: 'testnet', setupAbort: state.setupAbort, available: true, sourceNetworks: ['mainnet'], caps: null }),
  useLiveCopySetupActions: () => ({ pause: action(), resume: action(), edit: action(), renew: action(), topUp: action(), restart: action(), cancel: state.cancel, confirm: action() }),
  setupTerminal: (setup: { stage: string }) => ['running', 'failed', 'expired', 'cancelled'].includes(setup.stage),
  useLiveCopySetup: (id: string) => ({ data: { id }, error: null, isPending: false }),
}));
vi.mock('@/components/copy/live-copy-setup-dialogs', () => ({
  useLiveSetupText: () => liveSetupMessages.en, useCopyTexts: () => ({ live: liveSetupMessages.en }),
  LiveCopyConfirm: () => null, LiveCopyProgress: () => null, liveSetupError: () => '',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => '/portfolio', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/copy/live-copy-settings-fields', () => ({ LiveSettingsFields: () => null }));
vi.mock('@/lib/copy-live-setup-abort', () => ({ useLiveSetupAbort: () => ({ progress: null, error: null, loading: false }) }));
vi.mock('@/components/copy/live-copy-setup-abort', () => ({ LiveSetupAbortDialog: () => null }));

let root: Root, container: HTMLDivElement;
const mutateAsync = vi.fn(async (id: string) => ({ id, stage: 'funding_submitted', abortRequested: true }));
beforeEach(() => {
  state.setupAbort = true; mutateAsync.mockClear(); state.cancel = { isPending: false, mutate: vi.fn(), mutateAsync };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const awaiting = { id: '33333333-3333-4333-8333-333333333333', kind: 'start', stage: 'funding_submitted', issue: 'awaiting_credit', abortRequested: false, fundingStatus: 'accepted', consent: null };
const item = (setup: object) => ({ strategyId: 7, stage: 'setup', status: 'paused', network: 'testnet', setup, mandate: null, expiresAt: null, renewalDue: false,
  accountId: 'acct', pendingTransfer: null }) as never;
const render = (setup: object, locale: 'en' | 'zh-TW' = 'en') =>
  act(async () => root.render(<I18nProvider locale={locale} messages={catalogs[locale]}><LiveCopyActions item={item(setup)} strategy={null} /></I18nProvider>));
const buttons = () => [...document.querySelectorAll('button')];
const find = (label: string) => buttons().find(button => button.textContent === label);

it('offers 取消並退款 while the deposit awaits its credit, and confirms before calling the cancel', async () => {
  await render(awaiting, 'zh-TW');
  expect(catalogs['zh-TW'].liveCopyUi.cancelRefund).toBe('取消並退款');
  const offer = find('取消並退款')!;
  expect(offer).toBeTruthy();
  // The generic abort is not offered beside it.
  expect(find(catalogs['zh-TW'].liveCopyUi.abortAction)).toBeUndefined();
  await act(async () => offer.click());
  expect(mutateAsync).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(catalogs['zh-TW'].liveCopyUi.cancelRefundConfirm);
  const confirm = buttons().filter(button => button.textContent === '取消並退款').at(-1)!;
  await act(async () => confirm.click());
  expect(mutateAsync).toHaveBeenCalledExactlyOnceWith(awaiting.id);
  // Once requested, the saved progress is offered instead.
  expect(find(catalogs['zh-TW'].liveCopyUi.abortRefresh)).toBeTruthy();
  expect(find('取消並退款')).toBeUndefined();
});

it.each([
  ['another stage', { ...awaiting, stage: 'funded', issue: null }],
  ['a cancel already requested', { ...awaiting, abortRequested: true }],
])('is not offered for %s', async (_case, setup) => {
  await render(setup);
  expect(find(catalogs.en.liveCopyUi.cancelRefund)).toBeUndefined();
});

it('is not offered where the deployment cannot run the refund', async () => {
  state.setupAbort = false;
  await render(awaiting);
  expect(find(catalogs.en.liveCopyUi.cancelRefund)).toBeUndefined();
});

it('has its own words in English; the other languages use them', () => {
  expect(catalogs.en.liveCopyUi).toMatchObject({ cancelRefund: 'Cancel and refund', cancelRefundTitle: expect.any(String), cancelRefundConfirm: expect.stringContaining('main wallet') });
  for (const locale of ['ja', 'es', 'zh-CN'] as const) expect(catalogs[locale].liveCopyUi.cancelRefund).toBe('Cancel and refund');
});
