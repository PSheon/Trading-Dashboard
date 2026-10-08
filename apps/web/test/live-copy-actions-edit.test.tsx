// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveSetupMessages } from '@/i18n/live-setup';
import { LiveCopyActions } from '@/components/copy/live-copy-actions';

const state = vi.hoisted(() => ({ network: 'mainnet' as 'mainnet' | 'testnet', setupAbort: false, fullSetup: null as unknown, abortProgress: null as unknown, abortError: null as unknown }));
const action = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
vi.mock('@/lib/copy-live-setup', () => ({
  useLiveCopyDeployment: () => ({ network: state.network, setupAbort: state.setupAbort, available: true, sourceNetworks: ['mainnet'], caps: null }),
  useLiveCopySetupActions: () => ({ pause: action(), resume: action(), edit: action(), renew: action(), topUp: action(), restart: action(), cancel: action(), confirm: action() }),
  setupTerminal: () => true,
  useLiveCopySetup: (id: string) => ({ data: state.fullSetup ?? { id }, error: null, isPending: false }),
}));
vi.mock('@/components/copy/live-copy-setup-dialogs', () => ({
  useLiveSetupText: () => liveSetupMessages.en, useCopyTexts: () => ({ live: liveSetupMessages.en }),
  LiveCopyConfirm: () => null, LiveCopyProgress: () => null, liveSetupError: () => '',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => '/portfolio', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/copy/live-copy-settings-fields', () => ({ LiveSettingsFields: () => null }));
vi.mock('@/lib/copy-live-setup-abort', () => ({ useLiveSetupAbort: () => ({ progress: state.abortProgress, error: state.abortError, loading: false }) }));
vi.mock('@/components/copy/live-copy-setup-abort', () => ({ LiveSetupAbortDialog: ({ onRequested, onOpenChange }: { onRequested?(): void; onOpenChange(open: boolean): void }) => <div data-testid="original-abort-progress"><button onClick={() => { onRequested?.(); onOpenChange(false); }}>Confirm saved abort</button></div> }));

let root: Root, container: HTMLDivElement;
beforeEach(() => { state.setupAbort = false; state.fullSetup = null; state.abortProgress = null; state.abortError = null; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const item = { strategyId: 7, stage: 'active', status: 'active', network: 'mainnet', setup: null, mandate: { id: 'm', state: 'active' }, expiresAt: null, renewalDue: false,
  accountId: 'acct', pendingTransfer: false } as never;

it.each([['mainnet', false], ['testnet', true]] as const)('offers 編輯設定 for a running %s copy: %s (the api refuses a mainnet edit)', async (network, offered) => {
  state.network = network;
  await act(async () => root.render(<I18nProvider locale="en" messages={catalogs.en}><LiveCopyActions item={{ ...(item as object), network } as never} strategy={{ id: 7 } as never} /></I18nProvider>));
  const labels = [...container.querySelectorAll('button')].map(button => button.textContent);
  expect(labels).toContain(liveSetupMessages.en.pause);
  expect(labels.includes(liveSetupMessages.en.edit)).toBe(offered);
});

it('names the mainnet edit refusal in every language', () => {
  for (const messages of Object.values(liveSetupMessages)) expect(messages.errors.edit_unavailable.length).toBeGreaterThan(10);
  expect(liveSetupMessages['zh-TW'].errors.edit_unavailable).toContain('實盤跟單目前還不能編輯');
});

it.each([false, true])('keeps an aborted setup read-only even when rollout capability is %s', async enabled => {
  state.network = 'testnet'; state.setupAbort = enabled;
  const savedSetup = { id: 'original-setup', kind: 'start', stage: 'failed', abortRequested: true };
  await act(async () => root.render(<I18nProvider locale="en" messages={catalogs.en}><LiveCopyActions item={{ ...(item as object), network: 'testnet', stage: 'needs_deposit', setup: savedSetup } as never} strategy={null} /></I18nProvider>));
  const labels = [...container.querySelectorAll('button')].map(button => button.textContent);
  expect(labels).not.toContain(liveSetupMessages.en.restart);
  expect(labels).not.toContain(liveSetupMessages.en.cancelSetup);
  expect(labels).not.toContain(liveSetupMessages.en.topUp);
  const progress = [...container.querySelectorAll('button')].find(button => button.textContent === catalogs.en.liveCopyUi.abortRefresh)!;
  expect(progress).toBeTruthy();
  await act(async () => progress.click());
  expect(container.querySelector('[data-testid="original-abort-progress"]')).toBeTruthy();
});

const originalChange = { id: '11111111-1111-4111-8111-111111111111', kind: 'edit', strategyId: 7, accountId: 'acct', stage: 'cancelled', abortRequested: true };
it('after explicitly requesting an abort, closing before a server refresh never offers another deposit', async () => {
  state.network = 'testnet'; state.setupAbort = true;
  const original = { ...originalChange, kind: 'start', stage: 'provisioning', abortRequested: false, fundingStatus: null };
  await act(async () => root.render(<I18nProvider locale="en" messages={catalogs.en}><LiveCopyActions item={{ ...(item as object), network: 'testnet', stage: 'needs_deposit', setup: original } as never} strategy={null} /></I18nProvider>));
  const find = (label: string) => [...container.querySelectorAll('button')].find(button => button.textContent === label);
  expect(find(liveSetupMessages.en.topUp)).toBeTruthy();
  await act(async () => find(catalogs.en.liveCopyUi.abortAction)!.click());
  await act(async () => find('Confirm saved abort')!.click());
  expect(find(liveSetupMessages.en.topUp)).toBeUndefined();
  expect(find(liveSetupMessages.en.restart)).toBeUndefined();
  expect(find(liveSetupMessages.en.cancelSetup)).toBeUndefined();
  expect(find(catalogs.en.liveCopyUi.abortRefresh)).toBeTruthy();
});
function completedChange(kind = 'edit') { return { id: '22222222-2222-4222-8222-222222222222', setupId: originalChange.id, kind, strategyId: 7, accountId: 'acct', network: 'testnet', state: 'completed', issue: null, deposit: null, refund: null, stop: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }; }
async function changeActions(kind = 'edit', paused = false) {
  state.network = 'testnet'; state.fullSetup = { ...originalChange, kind };
  await act(async () => root.render(<I18nProvider locale="en" messages={catalogs.en}><LiveCopyActions item={{ ...(item as object), network: 'testnet', stage: paused ? 'paused' : 'active', status: paused ? 'paused' : 'active', setup: state.fullSetup, mandate: { id: 'm', state: paused ? 'paused' : 'active' } } as never} strategy={{ id: 7 } as never} /></I18nProvider>));
  return [...container.querySelectorAll('button')].map(b => b.textContent);
}
it.each(['edit', 'renewal'])('completed original %s permits future edit and top-up without reviving the aborted operation', async kind => {
  state.abortProgress = completedChange(kind);
  const labels = await changeActions(kind);
  expect(labels).toContain(liveSetupMessages.en.edit); expect(labels).toContain(liveSetupMessages.en.topUp);
  expect(labels).not.toContain(liveSetupMessages.en.restart); expect(labels).not.toContain(liveSetupMessages.en.cancelSetup);
  expect(labels).toContain(catalogs.en.liveCopyUi.abortRefresh);
});
it('completed change permits future operations on the paused original strategy', async () => { state.abortProgress = completedChange(); const labels = await changeActions('edit', true); expect(labels).toContain(liveSetupMessages.en.edit); expect(labels).toContain(liveSetupMessages.en.topUp); expect(labels).toContain(liveSetupMessages.en.resume); });
it.each(['requested', 'reconciling', 'refunding', 'blocked'])('a %s change never unlocks future financial actions', async status => { state.abortProgress = { ...completedChange(), state: status, issue: status === 'blocked' ? 'setup_abort_binding_unknown' : null }; const labels = await changeActions(); expect(labels).not.toContain(liveSetupMessages.en.edit); expect(labels).not.toContain(liveSetupMessages.en.topUp); });
it.each([{ network: 'mainnet' }, { setupId: '33333333-3333-4333-8333-333333333333' }, { accountId: 'other' }, { strategyId: 8 }])('rejects a completed change with different identity %j', async mismatch => { state.abortProgress = { ...completedChange(), ...mismatch }; const labels = await changeActions(); expect(labels).not.toContain(liveSetupMessages.en.edit); expect(labels).not.toContain(liveSetupMessages.en.topUp); });
it('an error with stale completed data never unlocks future actions', async () => { state.abortProgress = completedChange(); state.abortError = Error('owner changed'); const labels = await changeActions(); expect(labels).not.toContain(liveSetupMessages.en.edit); expect(labels).not.toContain(liveSetupMessages.en.topUp); });
it('a completed start never unlocks future actions on that original setup', async () => { state.abortProgress = completedChange('start'); const labels = await changeActions('start'); expect(labels).not.toContain(liveSetupMessages.en.edit); expect(labels).not.toContain(liveSetupMessages.en.topUp); });
