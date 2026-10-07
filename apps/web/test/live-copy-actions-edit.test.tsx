// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveSetupMessages } from '@/i18n/live-setup';
import { LiveCopyActions } from '@/components/copy/live-copy-actions';

const state = vi.hoisted(() => ({ network: 'mainnet' as 'mainnet' | 'testnet' }));
const action = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
vi.mock('@/lib/copy-live-setup', () => ({
  useLiveCopyDeployment: () => ({ network: state.network, available: true, sourceNetworks: ['mainnet'], caps: null }),
  useLiveCopySetupActions: () => ({ pause: action(), resume: action(), edit: action(), renew: action(), topUp: action(), restart: action(), cancel: action(), confirm: action() }),
  setupTerminal: () => true,
}));
vi.mock('@/components/copy/live-copy-setup-dialogs', () => ({
  useLiveSetupText: () => liveSetupMessages.en, useCopyTexts: () => ({ live: liveSetupMessages.en }),
  LiveCopyConfirm: () => null, LiveCopyProgress: () => null, liveSetupError: () => '',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => '/portfolio', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/copy/live-copy-settings-fields', () => ({ LiveSettingsFields: () => null }));

let root: Root, container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
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
