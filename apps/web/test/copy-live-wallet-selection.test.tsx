// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ExecutionWalletSettings } from '@/components/settings/execution-wallets';
import { I18nProvider } from '@/i18n/provider';
import { en } from '@/i18n/messages/en';
import { fixtureCopyOverview } from '@/fixtures/copy';
import { liveAccount, liveNow, liveOverview, liveOwner } from './copy-live-fixtures';
import { settleQueries, type SettleOptions } from './query-settle';
import { selectOptions } from './select-helper';
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), session: '1', status: 'signedIn', mode: 'privy' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ ...state, identity: 'owner', wallet: { address: liveOwner, signTypedData: vi.fn() } }) }));
vi.mock('@/lib/api', () => ({ api: { get: state.get, post: state.post }, sessionKey: () => state.session }));
vi.mock('@/lib/query-policy', () => ({ defaultRetry: { retry: false } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
let root: Root, container: HTMLDivElement, client: QueryClient, actual: ReturnType<typeof liveOverview>, wallets: { available: boolean; network: 'testnet' | 'mainnet'; accounts: typeof liveAccount[]; authorizations: [] };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { session: '1', status: 'signedIn', mode: 'privy' }); window.sessionStorage.clear(); vi.spyOn(Date, 'now').mockReturnValue(liveNow); state.get.mockReset(); state.post.mockReset(); actual = { ...liveOverview(), mandates: [] }; wallets = { available: true, network: 'testnet', accounts: [], authorizations: [] }; state.get.mockImplementation(async (path: string) => path === '/me/copy/live' ? actual : path === '/me/copy' ? { ...fixtureCopyOverview(), strategies: [] } : path === '/me/copy/execution-wallets' ? wallets : path === '/me/copy/agents' ? { available: false, network: 'testnet', setups: [] } : { available: false, network: 'testnet', operations: [] }); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });
// Waits for the wallet queries and mutations to answer.
const settle = (options?: SettleOptions) => settleQueries(client, { ms: 30, ...options });
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><ExecutionWalletSettings/></I18nProvider></QueryClientProvider>)); await settle(); }
// An actual copy starts one way only: setup, consent, worker. The lab's wallet
// form offers paper copies only and never reads or prepares actual strategies.
it('offers only paper copies: an actual paused draft is neither listed nor read nor prepared here', async () => {
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live' ? actual : path === '/me/copy' ? fixtureCopyOverview() : path === '/me/copy/execution-wallets' ? wallets : { available: false, network: 'testnet', operations: [] });
  await render();
  const options: { value: string; text: string }[] = [];
  for (const trigger of container.querySelectorAll('[data-slot="select-trigger"]')) options.push(...await selectOptions(trigger));
  expect(options.length).toBeGreaterThan(0);
  expect(options.some(o => o.text.endsWith(' · Actual'))).toBe(false);
  expect(container.textContent).not.toContain('Actual strategy preparation');
  expect(state.get.mock.calls.some(c => c[0] === '/me/copy/live')).toBe(false);
  expect(state.post).not.toHaveBeenCalled();
});
