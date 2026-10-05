// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveCopies } from '@/components/copy/live-copies';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveCopiesMessages } from '@/i18n/live-copies';
import { LOCALES, type Locale } from '@/i18n/config';
import { liveAccount, liveMandate, liveNow } from './copy-live-fixtures';
import { settleQueries } from './query-settle';

const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), sign: vi.fn(), snapshot: null as unknown }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: 'owner@email', wallet: { address: `0x${'11'.repeat(20)}`, signTypedData: state.sign } }) }));
vi.mock('@/lib/api', () => ({ api: { get: state.get, post: state.post }, sessionKey: () => '1' }));
vi.mock('@/lib/copy-execution-wallets', () => ({ useExecutionWallets: () => ({ data: { accounts: [liveAccount] } }) }));
vi.mock('@/lib/copy-live', () => ({ useLiveCopyOverview: () => ({ data: { mandates: [{ ...liveMandate, state: 'active' }] } }) }));
vi.mock('@/lib/copy-follower-snapshot', () => ({ useCopyFollowerSnapshot: () => ({ data: state.snapshot }) }));
vi.mock('@/components/copy/copy-live-stop', () => ({ CopyLiveStop: () => <div data-testid="stop">stop</div> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/portfolio', useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const signature = `0x${'aa'.repeat(65)}`;
const item = (over: Record<string, unknown> = {}) => ({ strategyId: liveAccount.strategyId, leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'mainnet', budgetUsd: '100',
  status: 'active', stage: 'active', createdAt: new Date(liveNow).toISOString(), accountId: liveAccount.id, accountAddress: liveAccount.address,
  mandate: { id: liveMandate.id, state: 'active', revision: 3 }, stop: null, pendingTransfer: null, lastRefusal: null, ...over });
const observed = (positions: { coin: string; size: string }[]) => ({ status: 'observed', metrics: { perpEquity: '97.5', withdrawable: '80.25', unrealizedPnl: '0.5' },
  positions: positions.map(p => ({ ...p, dex: '', asset: 0, sizeDecimals: 2, entryPrice: '100', positionValue: '19', unrealizedPnl: '0.5', marginUsed: '1.9', leverage: 10,
    leverageType: 'cross', maxLeverage: 20, fundingSinceOpen: '0', fundingSinceChange: '0' })), restingOrders: [] });
let root: Root, container: HTMLDivElement, client: QueryClient, items: ReturnType<typeof item>[];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  items = [item()]; state.snapshot = observed([{ coin: 'BTC', size: '0.19' }]);
  state.get.mockReset().mockImplementation(async (path: string) => path === '/me/copy/live/portfolio' ? { network: 'testnet', automaticExecution: true, items } : null);
  state.post.mockReset(); state.sign.mockReset().mockResolvedValue(signature);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
const settle = () => settleQueries(client, { ms: 15 });
async function render(locale: Locale = 'en') {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><LiveCopies /></I18nProvider></QueryClientProvider>));
  await settle();
}
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!;

it('lists each testnet copy with its stage, balances and positions, and nothing without copies', async () => {
  items = [];
  await render(); expect(container.textContent).toBe('');
  items = [item(), item({ strategyId: 99, stage: 'needs_deposit', status: 'paused', lastRefusal: { reason: 'live_source_price_deviation', at: new Date(liveNow).toISOString() } })];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(container.textContent).toContain('Testnet copies');
  expect(container.textContent).toContain('Active'); expect(container.textContent).toContain('Mainnet leader');
  expect(container.textContent).toContain('Needs deposit'); expect(container.textContent).toContain('Deposit USDC from your main wallet');
  expect(container.textContent).toContain('testnet price too far from mainnet');
  expect(container.textContent).toContain('$97.50'); expect(container.textContent).toContain('BTC');
  expect(container.querySelector('a[href="/settings?tab=account"]')).not.toBeNull();
});

it('withdraws idle funds: the owner signs the exact consent, then the approval goes out once', async () => {
  const operation = { id: '22222222-2222-4222-8222-222222222222', accountId: liveAccount.id, strategyId: liveAccount.strategyId, network: 'testnet', address: liveAccount.address,
    destination: `0x${'11'.repeat(20)}`, amount: '12.5', nonce: liveNow, status: 'prepared', canCancel: true, transactionHash: null, creditedAmount: null, fee: null,
    direction: 'to_main', stopId: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() };
  state.post.mockImplementation(async (path: string) => path.endsWith('/returns')
    ? { operation, consent: { operationId: operation.id, network: 'testnet', account: liveAccount.address, destination: operation.destination, amount: '12.5', nonce: liveNow, consentExpiresAt: liveNow + 300000 } }
    : { ...operation, status: 'accepted' });
  await render();
  await act(async () => {
    const input = container.querySelector('input[name="withdraw"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '12.5'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Withdraw idle funds').click()); await settle();
  expect(state.post.mock.calls[0]![0]).toBe(`/me/copy/live/execution-wallets/${liveAccount.id}/returns`);
  expect(state.post.mock.calls[0]![1]).toMatchObject({ amount: '12.5' });
  expect(state.sign.mock.calls[0]![0]).toMatchObject({ primaryType: 'CopyAccountReturn', message: { amount: '12.5', destination: operation.destination } });
  expect(state.post.mock.calls[1]).toEqual([`/me/copy/live/returns/${operation.id}/approve`, { consentSignature: signature }]);
});

it('an account with the automatic return: idle funds go back without a signature, and after a stop it returns by itself', async () => {
  items = [item({ automaticReturn: true })];
  const operation = { id: '22222222-2222-4222-8222-222222222222', accountId: liveAccount.id, strategyId: liveAccount.strategyId, network: 'testnet', address: liveAccount.address,
    destination: `0x${'11'.repeat(20)}`, amount: '12.5', nonce: liveNow, status: 'prepared', canCancel: true, transactionHash: null, creditedAmount: null, fee: null,
    direction: 'to_main', stopId: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() };
  state.post.mockImplementation(async (path: string) => path.endsWith('/returns')
    ? { operation, consent: { operationId: operation.id, network: 'testnet', account: liveAccount.address, destination: operation.destination, amount: '12.5', nonce: liveNow, consentExpiresAt: liveNow + 300000 } }
    : { ...operation, status: 'accepted' });
  await render();
  await act(async () => {
    const input = container.querySelector('input[name="withdraw"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '12.5'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Withdraw idle funds').click()); await settle();
  expect(state.sign).not.toHaveBeenCalled();
  expect(state.post.mock.calls[1]).toEqual([`/me/copy/live/returns/${operation.id}/approve`, {}]);
  // Flat after a stop: 自動返還中, no button to return by hand.
  items = [item({ automaticReturn: true, stage: 'sweeping', status: 'stopping', stop: { id: '44444444-4444-4444-8444-444444444444', state: 'flat', issue: 'stop_returning_to_main_wallet', revision: 4 },
    pendingTransfer: { id: '55555555-5555-4555-8555-555555555555', direction: 'to_main', status: 'accepted', amount: '97.5' }, sweep: { amount: '97.5', status: 'accepted' } })];
  state.snapshot = observed([]);
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(container.textContent).toContain('Returning automatically'); expect(container.textContent).toContain('nothing to sign');
  expect(button('Return all to main wallet')).toBeUndefined();
  items = [item({ automaticReturn: true, stage: 'stopped', status: 'stopped', stop: null, sweep: { amount: '97.5', status: 'credited' } })];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(container.textContent).toContain('Returned 97.5 USDC to your main wallet');
  await render('zh-TW');
  expect(container.textContent).toContain('已返還 97.5 USDC 至主錢包');
});

it('closes one position, signs the cancellation consent while cancelling, and returns everything when flat', async () => {
  state.post.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', accountId: liveAccount.id, strategyId: liveAccount.strategyId, coin: 'BTC', state: 'requested', reason: null, orders: 0,
    createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() });
  await render();
  await act(async () => button('Close').click()); await settle();
  expect(state.post.mock.calls[0]![0]).toBe(`/me/copy/live/execution-wallets/${liveAccount.id}/positions/close`);
  expect(state.post.mock.calls[0]![1]).toMatchObject({ coin: 'BTC' });
  items = [item({ stage: 'stopping', status: 'stopping', stop: { id: '44444444-4444-4444-8444-444444444444', state: 'cancelling', issue: 'stop_cancellation_consent_required', revision: 2 } })];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(button('Close')).toBeUndefined(); // the stop closes positions now
  expect(button('Sign consent to cancel orders')).toBeDefined();
  items = [item({ stage: 'sweeping', status: 'stopping', stop: { id: '44444444-4444-4444-8444-444444444444', state: 'flat', issue: null, revision: 4 } })];
  state.snapshot = observed([]);
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(container.textContent).toContain('Returning funds'); expect(container.textContent).toContain('No open positions');
  expect(button('Return all to main wallet')).toBeDefined();
});

it.each(LOCALES)('renders every stage in %s', async locale => {
  items = (['setup', 'needs_deposit', 'funding', 'awaiting_credit', 'starting', 'active', 'paused', 'stopping', 'sweeping', 'stopped'] as const).map((stage, i) => item({ strategyId: i + 1, stage }));
  await render(locale);
  for (const stage of Object.values(liveCopiesMessages[locale].stages)) expect(container.textContent).toContain(stage);
});

it('says the copies could not be read, with a retry, instead of hiding the section', async () => {
  let fail = true;
  items = [item()];
  state.get.mockImplementation(async (path: string) => {
    if (path !== '/me/copy/live/portfolio') return null;
    if (fail) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    return { network: 'testnet', automaticExecution: true, items };
  });
  await render();
  expect(container.textContent).toContain('Testnet copies');
  expect(container.textContent).toContain(catalogs.en.common.error);
  fail = false;
  await act(async () => button(catalogs.en.common.retry).click()); await settle();
  expect(container.textContent).toContain('Active');
});

it('a prepared return can be cancelled from the portfolio (its consent key does not survive a reload)', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  items = [item({ pendingTransfer: { id, direction: 'to_main', status: 'prepared', amount: '12.5' } })];
  state.post.mockImplementation(async () => ({ id, accountId: liveAccount.id, strategyId: liveAccount.strategyId, network: 'testnet', address: liveAccount.address,
    destination: `0x${'11'.repeat(20)}`, amount: '12.5', nonce: liveNow, status: 'cancelled', canCancel: false, transactionHash: null, creditedAmount: null, fee: null,
    direction: 'to_main', stopId: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() }));
  await render();
  await act(async () => button('Cancel this return').click()); await settle();
  expect(state.post).toHaveBeenCalledWith(`/me/copy/funding/${id}/cancel`, {});
  expect(container.textContent).not.toContain('The action did not complete');
});
