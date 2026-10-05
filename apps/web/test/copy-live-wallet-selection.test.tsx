// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ExecutionWalletSettings } from '@/components/settings/execution-wallets';
import { I18nProvider } from '@/i18n/provider';
import { en } from '@/i18n/messages/en';
import { fixtureCopyOverview } from '@/fixtures/copy';
import { liveAccount, liveNow, liveOverview, liveOwner, liveStrategy } from './copy-live-fixtures';
import { settleQueries, type SettleOptions } from './query-settle';
import { chooseOption, selectOptions } from './select-helper';
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), session: '1', status: 'signedIn', mode: 'privy' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ ...state, identity: 'owner', wallet: { address: liveOwner, signTypedData: vi.fn() } }) }));
vi.mock('@/lib/api', () => ({ api: { get: state.get, post: state.post }, sessionKey: () => state.session }));
vi.mock('@/lib/query-policy', () => ({ defaultRetry: { retry: false } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
let root: Root, container: HTMLDivElement, client: QueryClient, actual: ReturnType<typeof liveOverview>, wallets: { available: boolean; network: 'testnet' | 'mainnet'; accounts: typeof liveAccount[]; authorizations: [] };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { session: '1', status: 'signedIn', mode: 'privy' }); window.sessionStorage.clear(); vi.spyOn(Date, 'now').mockReturnValue(liveNow); state.get.mockReset(); state.post.mockReset(); actual = { ...liveOverview(), mandates: [] }; wallets = { available: true, network: 'testnet', accounts: [], authorizations: [] }; state.get.mockImplementation(async (path: string) => path === '/me/copy/live' ? actual : path === '/me/copy' ? { ...fixtureCopyOverview(), strategies: [] } : path === '/me/copy/execution-wallets' ? wallets : path === '/me/copy/agents' ? { available: false, network: 'testnet', setups: [] } : { available: false, network: 'testnet', operations: [] }); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });
// Waits for the wallet queries and mutations to answer; settleHeld() waits for
// queries only, while a test holds the preparation POST open.
const settle = (options?: SettleOptions) => settleQueries(client, { ms: 30, ...options });
const settleHeld = () => settle({ mutations: false });
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><ExecutionWalletSettings/></I18nProvider></QueryClientProvider>)); await settle(); }
async function walletSelect() { for (const trigger of container.querySelectorAll('[data-slot="select-trigger"]')) { if ((await selectOptions(trigger)).some(o => o.text.endsWith(' · Actual'))) return trigger; } return undefined; }
async function choose() { await chooseOption((await walletSelect())!, String(liveStrategy.id)); await settle(); }
async function click(label: string, wait: () => Promise<void> = settle) { const b = [...container.querySelectorAll('button')].find(b => b.textContent === label)!; expect(b).toBeTruthy(); await act(async () => b.click()); await wait(); }
it('makes a new actual paused draft selectable for a dedicated testnet master without paper money', async () => { await render(); expect(await walletSelect()).toBeTruthy(); expect(state.post).not.toHaveBeenCalled(); await choose(); state.post.mockImplementation(async (_path, _body, options) => { options.beforeSend(); wallets.accounts = [liveAccount]; return liveAccount; }); await click('Prepare dedicated wallet'); expect(state.post).toHaveBeenCalledExactlyOnceWith('/me/copy/strategies/9/execution-wallet', { network: 'testnet' }, { beforeSend: expect.any(Function) }); expect(container.textContent).toContain('Automatic testnet execution is off on this server'); expect(container.textContent).not.toContain('Paper account'); });
it('lost actual master preparation only reads the original strategy after reload with zero second POST', async () => { await render(); await choose(); state.post.mockRejectedValue(new Error('lost')); await click('Prepare dedicated wallet'); expect(container.textContent).toContain('Original request unconfirmed'); wallets.accounts = [liveAccount]; await click('Check original request'); expect(state.post).toHaveBeenCalledOnce(); expect(state.get.mock.calls.filter(c => c[0] === '/me/copy/execution-wallets').length).toBeGreaterThan(1); });
it('same-session selected-strategy revision change before final send prevents HTTP', async () => { let finish!: () => void; const http = vi.fn(); state.post.mockImplementation(async (_path, _body, options) => { await new Promise<void>(r => { finish = r; }); options.beforeSend(); http(); return liveAccount; }); await render(); await choose(); await click('Prepare dedicated wallet', settleHeld); actual = { ...actual, strategies: [{ ...liveStrategy, version: 2 }] }; await act(async () => { await client.invalidateQueries({ queryKey: ['copy'] }); }); await settleHeld(); await act(async () => finish()); await settle(); expect(http).not.toHaveBeenCalled(); });
it('lists an actual testnet draft that copies a mainnet leader (trader pages are mainnet addresses)', async () => { actual = { ...actual, strategies: [{ ...liveStrategy, sourceNetwork: 'mainnet' }] }; await render(); const trigger = await walletSelect(); expect(trigger).toBeTruthy(); expect((await selectOptions(trigger!)).some(o => o.value === String(liveStrategy.id))).toBe(true); });
it('never converts actual testnet drafts to the mainnet execution-wallet deployment', async () => { wallets.network = 'mainnet'; await render(); expect(await walletSelect()).toBeUndefined(); expect(state.post).not.toHaveBeenCalled(); });
it('demo owner hides actual strategies and all actual preparation controls', async () => { state.mode = 'fixture'; await render(); expect(await walletSelect()).toBeUndefined(); expect(container.textContent).not.toContain('Actual strategy preparation'); expect(state.get.mock.calls.some(c => c[0] === '/me/copy/live')).toBe(false); });
