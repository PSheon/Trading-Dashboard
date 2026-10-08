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

const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), sign: vi.fn(), addSigners: vi.fn(async () => undefined), snapshot: null as unknown, strategies: [] as unknown[], refetch: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: 'owner@email', wallet: { address: `0x${'11'.repeat(20)}`, signTypedData: state.sign, addSigners: state.addSigners } }) }));
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: { get: state.get, patch: state.patch, post: (...args: unknown[]) => Promise.resolve((state.post as (...a: unknown[]) => unknown)(...args)) }, sessionKey: () => '1' }));
vi.mock('@/lib/copy-execution-wallets', () => ({ useExecutionWallets: () => ({ data: { accounts: [liveAccount] } }) }));
vi.mock('@/lib/copy-live', () => ({ useLiveCopyOverview: () => ({ data: { mandates: [{ ...liveMandate, state: 'active' }], strategies: state.strategies } }) }));
vi.mock('@/lib/copy-follower-snapshot', () => ({ useCopyFollowerSnapshot: () => ({ data: state.snapshot, refetch: state.refetch }) }));
vi.mock('@/components/copy/copy-live-stop', () => ({ CopyLiveStop: () => <div data-testid="stop">stop</div>, LiveCopyStopAction: () => <div data-testid="stop">stop</div> }));
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
/** Orbie's money-flow ledger: the copy's deposits and returns (its net deposits). */
let funds: unknown[];
const deposit = (amount: number, over: Record<string, unknown> = {}) => ({ id: `funding:${Math.random()}`, time: new Date(liveNow - 60_000).toISOString(), kind: 'copy_funding', mode: 'testnet', amount,
  strategyId: liveAccount.strategyId, leaderAddress: `0x${'44'.repeat(20)}`, status: 'credited', txHash: null, fee: null, counterparty: liveAccount.address, count: null, ...over });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  items = [item()]; state.snapshot = observed([{ coin: 'BTC', size: '0.19' }]); state.strategies = []; state.patch.mockReset();
  funds = [deposit(100)];
  state.get.mockReset().mockImplementation(async (path: string) => path === '/me/copy/live/portfolio' ? { network: 'testnet', automaticExecution: true, items }
    : path.startsWith('/me/funds/history') ? { items: funds, nextCursor: null } : null);
  state.post.mockReset(); state.sign.mockReset().mockResolvedValue(signature);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
const settle = () => settleQueries(client, { ms: 15 });
/** Renders the list and, unless `open` is false, opens the first copy's detail sheet (Paul, 2026-10-06: a card per copy, its actions in a sheet). */
async function render(locale: Locale = 'en', { open = true }: { open?: boolean } = {}) {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><LiveCopies /></I18nProvider></QueryClientProvider>));
  await settle();
  if (open && cards().length && !document.querySelector('[data-testid="live-copy-sheet"]')) await openCard(0);
}
const cards = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="live-copy-card"]')];
async function openCard(index: number) { await act(async () => cards()[index]!.click()); await settle(); }
const detail = () => document.querySelector('[data-testid="live-copy-sheet"]') as HTMLElement | null;
/** The dialog on top (the copy's sheet is one too). */
const topDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label)!;
/** The confirm sheet in front of every withdrawal and return (Paul, 2026-10-06). */
const sheet = () => document.querySelector('[data-testid="transfer-confirm"]') as HTMLElement | null;
const sheetButton = (label: string) => [...(sheet()?.querySelectorAll('button') ?? [])].find(b => b.textContent === label) as HTMLButtonElement | undefined;

it('lists each testnet copy with its stage, balances and positions, and nothing without copies', async () => {
  items = [];
  await render(); expect(container.textContent).toBe('');
  items = [item(), item({ strategyId: 99, stage: 'needs_deposit', status: 'paused', lastRefusal: { reason: 'live_source_price_deviation', at: new Date(liveNow).toISOString() } })];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  // Two lines per card: name and status; PnL (equity less the budget) and ROI.
  expect(cards()).toHaveLength(2);
  expect(cards()[0]!.textContent).toContain('Strategy enabled'); expect(cards()[0]!.textContent).toContain('-$2.50'); expect(cards()[0]!.textContent).toContain('2.5%');
  expect(cards()[1]!.textContent).toContain('Setting up');
  await openCard(0);
  expect(detail()!.textContent).toContain('Strategy enabled'); expect(detail()!.textContent).toContain('$97.50'); expect(detail()!.textContent).toContain('BTC');
  await act(async () => { (document.querySelector('[role="dialog"] button[aria-label="Close"]') as HTMLButtonElement).click(); }); await settle();
  await openCard(1);
  expect(detail()!.textContent).toContain('Needs deposit'); expect(detail()!.textContent).toContain('Deposit USDC from your main wallet');
  expect(detail()!.textContent).toContain('price too far from the trader’s fill');
  // One-click: the deposit is a silent top-up here, not the Settings forms.
  expect(document.querySelector('a[href="/en/settings?tab=account"]')).toBeNull();
  expect([...detail()!.querySelectorAll('button')].filter(b => b.textContent === 'Add funds')).toHaveLength(1);
});

it.each(['stopping', 'sweeping'])('withholds PnL during %s even if the funds ledger credited the return before the account snapshot refreshed', async (stage) => {
  items = [item({ stage, status: 'stopping' })];
  funds = [deposit(100), deposit(97.5, { counterparty: `0x${'11'.repeat(20)}` })];
  await render('en', { open: false });
  expect(cards()[0]!.textContent).not.toContain('+$95.00');
  expect(cards()[0]!.textContent).toContain('—');
  expect(cards()[0]!.textContent).not.toContain('3,800');
});

it('withdraws idle funds: nothing to sign, the worker signs it and the approval goes out once', async () => {
  const operation = { id: '22222222-2222-4222-8222-222222222222', accountId: liveAccount.id, strategyId: liveAccount.strategyId, network: 'testnet', address: liveAccount.address,
    destination: `0x${'11'.repeat(20)}`, amount: '12.5', nonce: liveNow, status: 'prepared', canCancel: true, transactionHash: null, creditedAmount: null, fee: null,
    direction: 'to_main', stopId: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() };
  state.post.mockImplementation(async (path: string) => path.endsWith('/returns')
    ? { operation }
    : { ...operation, status: 'accepted' });
  await render();
  await act(async () => {
    const input = document.querySelector('input[name="withdraw"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '12.5'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Withdraw idle funds').click()); await settle();
  await act(async () => sheetButton('Confirm withdrawal')!.click()); await settle();
  expect(state.post.mock.calls[0]![0]).toBe(`/me/copy/live/execution-wallets/${liveAccount.id}/returns`);
  expect(state.post.mock.calls[0]![1]).toMatchObject({ amount: '12.5' });
  expect(state.sign).not.toHaveBeenCalled();
  expect(state.post.mock.calls[1]).toEqual([`/me/copy/live/returns/${operation.id}/approve`, {}]);
});

it('an account with the automatic return: idle funds go back without a signature, and after a stop it returns by itself', async () => {
  items = [item({ automaticReturn: true })];
  const operation = { id: '22222222-2222-4222-8222-222222222222', accountId: liveAccount.id, strategyId: liveAccount.strategyId, network: 'testnet', address: liveAccount.address,
    destination: `0x${'11'.repeat(20)}`, amount: '12.5', nonce: liveNow, status: 'prepared', canCancel: true, transactionHash: null, creditedAmount: null, fee: null,
    direction: 'to_main', stopId: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() };
  state.post.mockImplementation(async (path: string) => path.endsWith('/returns')
    ? { operation }
    : { ...operation, status: 'accepted' });
  await render();
  await act(async () => {
    const input = document.querySelector('input[name="withdraw"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '12.5'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Withdraw idle funds').click()); await settle();
  // The same confirm sheet as every account: nothing is sent until it is confirmed.
  expect(sheet()!.textContent).toContain('12.5 USDC'); expect(sheet()!.textContent).toContain('Your main wallet · 0x1111…1111');
  expect(sheet()!.textContent).toContain('Hyperliquid testnet'); expect(sheet()!.textContent).toContain('About 1 minute');
  expect(state.post).not.toHaveBeenCalled();
  await act(async () => sheetButton('Confirm withdrawal')!.click()); await settle();
  expect(state.sign).not.toHaveBeenCalled();
  expect(state.post.mock.calls[1]).toEqual([`/me/copy/live/returns/${operation.id}/approve`, {}]);
  // Flat after a stop: 自動返還中, no button to return by hand.
  items = [item({ automaticReturn: true, stage: 'sweeping', status: 'stopping', stop: { id: '44444444-4444-4444-8444-444444444444', state: 'flat', issue: 'stop_returning_to_main_wallet', revision: 4 },
    pendingTransfer: { id: '55555555-5555-4555-8555-555555555555', direction: 'to_main', status: 'accepted', amount: '97.5' }, sweep: { amount: '97.5', status: 'accepted' } })];
  state.snapshot = observed([]);
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(detail()!.textContent).toContain('Returning automatically'); expect(detail()!.textContent).toContain('nothing to sign');
  expect(button('Return all to main wallet')).toBeUndefined();
  items = [item({ automaticReturn: true, stage: 'stopped', status: 'stopped', stop: null, sweep: { amount: '97.5', status: 'credited' } })];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  // Stopped: folded under 已結束; its sheet says what came back.
  await act(async () => { (container.querySelector('summary') as HTMLElement).click(); });
  expect(detail()!.textContent).toContain('Returned 97.5 USDC to your main wallet');
  await render('zh-TW');
  expect(detail()!.textContent).toContain('已返還 97.5 USDC 至主錢包');
});

it('closes one position, has nothing to sign while cancelling, and returns everything when flat', async () => {
  state.post.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', accountId: liveAccount.id, strategyId: liveAccount.strategyId, coin: 'BTC', state: 'requested', reason: null, orders: 0,
    createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() });
  await render();
  await act(async () => button('Close').click()); await settle();
  expect(state.post.mock.calls[0]![0]).toBe(`/me/copy/live/execution-wallets/${liveAccount.id}/positions/close`);
  expect(state.post.mock.calls[0]![1]).toMatchObject({ coin: 'BTC' });
  items = [item({ stage: 'stopping', status: 'stopping', stop: { id: '44444444-4444-4444-8444-444444444444', state: 'cancelling', issue: 'stop_cancellation_consent_required', revision: 2 } })];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(button('Close')).toBeUndefined(); // the stop closes positions now
  // The worker cancels the copy's orders under the setup's consent: no prompt.
  expect(button('Sign consent to cancel orders')).toBeUndefined();
  items = [item({ stage: 'sweeping', status: 'stopping', stop: { id: '44444444-4444-4444-8444-444444444444', state: 'flat', issue: null, revision: 4 } })];
  state.snapshot = observed([]);
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(detail()!.textContent).toContain('Returning funds'); expect(detail()!.textContent).toContain('No open positions');
  expect(button('Return all to main wallet')).toBeDefined();
});

it.each(LOCALES)('renders every stage in %s', async locale => {
  items = (['setup', 'needs_deposit', 'funding', 'awaiting_credit', 'starting', 'active', 'paused', 'stopping', 'sweeping', 'stopped'] as const).map((stage, i) => item({ strategyId: i + 1, stage }));
  await render(locale, { open: false });
  const stages = liveCopiesMessages[locale].stages, keys = ['setup', 'needs_deposit', 'funding', 'awaiting_credit', 'starting', 'active', 'paused', 'stopping', 'sweeping'] as const;
  // Stopped copies fold under 已結束; every other card opens a sheet that names its stage.
  expect(cards()).toHaveLength(keys.length + 1);
  expect(container.textContent).toContain(catalogs[locale].folio.ended.replace('{count}', '1'));
  for (const [i, key] of keys.entries()) {
    await openCard(i);
    expect(detail()!.textContent, key).toContain(key === 'active' ? catalogs[locale].liveCopyUi.enabled : stages[key]);
    await act(async () => { (document.querySelector('[role="dialog"] button[aria-label]') as HTMLButtonElement).click(); }); await settle();
  }
});

it('says the copies could not be read, with a retry, instead of hiding the section', async () => {
  let fail = true;
  items = [item()];
  state.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/me/funds/history')) return { items: funds, nextCursor: null };
    if (path !== '/me/copy/live/portfolio') return null;
    if (fail) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    return { network: 'testnet', automaticExecution: true, items };
  });
  await render();
  expect(container.textContent).toContain('Copying');
  expect(container.textContent).toContain(catalogs.en.common.error);
  fail = false;
  await act(async () => button(catalogs.en.common.retry).click()); await settle();
  expect(cards()).toHaveLength(1);
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
  expect(document.body.textContent).not.toContain('The action did not complete');
});

it('a start that ended after its deposit arrived (no stop to sweep it) offers 全部返還主錢包, signed by the worker on an automatic account', async () => {
  const operation = { id: '66666666-6666-4666-8666-666666666666', accountId: liveAccount.id, strategyId: liveAccount.strategyId, network: 'testnet', address: liveAccount.address,
    destination: `0x${'11'.repeat(20)}`, amount: '100', nonce: liveNow, status: 'prepared', canCancel: true, transactionHash: null, creditedAmount: null, fee: null,
    direction: 'to_main', stopId: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() };
  state.post.mockImplementation(async (path: string) => path.endsWith('/returns')
    ? { operation }
    : { ...operation, status: 'accepted' });
  items = [item({ automaticReturn: true, stage: 'sweeping', status: 'stopped', mandate: null, stop: null, sweep: null })];
  state.snapshot = observed([]);
  await render();
  expect(detail()!.textContent).not.toContain('Returning automatically');
  await act(async () => button('Return all to main wallet').click()); await settle();
  expect(sheet()!.dataset.kind).toBe('returnAll'); expect(state.post).not.toHaveBeenCalled();
  await act(async () => sheetButton('Confirm return')!.click()); await settle();
  expect(state.post.mock.calls[0]).toEqual([`/me/copy/live/execution-wallets/${liveAccount.id}/returns`, { idempotencyKey: expect.any(String), amount: 'all' }]);
  expect(state.post.mock.calls[1]).toEqual([`/me/copy/live/returns/${operation.id}/approve`, {}]);
  expect(state.sign).not.toHaveBeenCalled();
});

it('加碼 that fails keeps the dialog and the typed amount, with the reason', async () => {
  const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  state.post.mockRejectedValue(new ApiError(409, 'busy', { code: 'funding_pending' }));
  await render('zh-TW');
  await act(async () => button('加碼').click());
  const input = () => topDialog().querySelector('input') as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '25'); input().dispatchEvent(new Event('input', { bubbles: true })); });
  const submit = [...topDialog().querySelectorAll('button')].find(b => b.textContent?.includes('25'))!;
  await act(async () => (submit as HTMLButtonElement).click()); await settle();
  expect(input()).toBeTruthy();
  expect(input().value).toBe('25');
  expect(topDialog().textContent).toContain('已有一筆入金正在處理');
});

it("a transfer in flight is said in the page's language, never as the raw status", async () => {
  items = [item({ stage: 'funding', status: 'paused', pendingTransfer: { id: '77777777-7777-4777-8777-777777777777', direction: 'to_account', status: 'prepared', amount: '100' } })];
  await render('zh-TW');
  expect(detail()!.textContent).toContain('入金・等待送出：100 USDC');
  expect(detail()!.textContent).not.toMatch(/prepared|unknown|accepted/);
  for (const locale of LOCALES) {
    const text = liveCopiesMessages[locale];
    for (const status of ['prepared', 'unknown', 'accepted'] as const) expect(text.transferStatus[status], locale).not.toBe(status);
    for (const direction of ['to_account', 'to_main'] as const) expect(text.transferDirection[direction].trim(), locale).not.toBe('');
    expect(text.transfer, locale).toContain('{status}');
  }
});

it("a setup left at its consent (the panel closed during a slow start, automatic return on): 繼續設定 opens the confirm sheet, which adds the worker and confirms", async () => {
  const at = Date.now(), id = '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', owner = `0x${'11'.repeat(20)}`;
  const consent = { kind: 'start', setupId: id, userId: 1, ownerAddress: owner, ownerPrivyUserId: 'did:privy:owner', strategyId: liveAccount.strategyId, leaderAddress: `0x${'44'.repeat(20)}`,
    sourceNetwork: 'mainnet', network: 'testnet', budgetUsd: '100', settingsDigest: 'a'.repeat(64), accountId: liveAccount.id, accountAddress: `0x${'22'.repeat(20)}`, accountAbstraction: 'disabled',
    agentAddress: `0x${'33'.repeat(20)}`, agentPolicyId: 'policy', agentPolicyFingerprint: 'b'.repeat(64), workerQuorumId: 'worker', agentValidUntil: at + 30 * 86_400_000, builderAddress: null,
    builderMaxFeeTenthsOfBps: 0, sweepDestination: owner, masterPolicyId: 'master-policy', masterPolicyFingerprint: 'c'.repeat(64), fundingOperationId: '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f',
    fundingNonce: at - 10, fundingAmount: '100', nonce: at, consentExpiresAt: at + 300_000, setupDeadline: at + 86_400_000 };
  const setup = { id, kind: 'start', strategyId: liveAccount.strategyId, accountId: liveAccount.id, leaderAddress: consent.leaderAddress, sourceNetwork: 'mainnet', budgetUsd: '100',
    settings: { direction: 'same', sizingMode: 'ratio', perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: 'delta' }, stage: 'awaiting_consent', issue: null,
    consent, funding: null, mandateId: null, setupDeadline: null, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() };
  items = [item({ stage: 'setup', status: 'paused', mandate: null, setup: { id, kind: 'start', stage: 'awaiting_consent', issue: null, consent } })];
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live/portfolio' ? { network: 'testnet', automaticExecution: true, items } : path === `/me/copy/live/setups/${id}` ? setup : path.startsWith('/me/funds/history') ? { items: funds, nextCursor: null } : null);
  state.post.mockResolvedValue({ ...setup, consent: null, stage: 'funding_submitted' });
  await render('zh-TW');
  await act(async () => button('繼續設定').click()); await settle();
  const sheet = [...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent?.includes('確認跟單設定'));
  expect(sheet).toBeTruthy();
  const go = [...sheet!.querySelectorAll('button')].find(b => b.textContent === '確認並開始')!;
  await act(async () => go.click()); await settle();
  expect(state.addSigners).toHaveBeenCalledExactlyOnceWith(consent.accountAddress, [{ signerId: 'worker', policyIds: ['master-policy'] }]);
  expect(state.post).toHaveBeenCalledWith(`/me/copy/live/setups/${id}/confirm`, expect.objectContaining({ consentSignature: expect.any(String), fundingSignature: expect.any(String) }));
});

it("a failed edit says why inside the edit dialog, which stays open on top (web audit M3)", async () => {
  const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  const { copyErrorMessages } = await import('@/i18n/copy-errors');
  state.strategies = [{ id: liveAccount.strategyId, mode: 'actual', network: 'testnet', sourceNetwork: 'mainnet', leaderAddress: `0x${'44'.repeat(20)}`, budgetUsd: '100', status: 'active', version: 1,
    settings: { direction: 'same', sizingMode: 'ratio', perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' }, pauseNewRisk: false, reduceOnly: false, createdAt: new Date(liveNow).toISOString() }];
  state.patch.mockRejectedValue(new ApiError(409, 'A stop is in progress for this copy', { code: 'live_stop_in_progress' }));
  await render();
  await act(async () => button('Edit settings').click());
  const dialog = () => topDialog();
  await act(async () => { (dialog().querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
  await settle();
  expect(dialog()).toBeTruthy();
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe(copyErrorMessages.en.codes.live_stop_in_progress);
});

it('the withdraw box shows a placeholder and the most you can withdraw, 全部 fills it, and a transfer in flight says so instead of vanishing', async () => {
  await render('zh-TW');
  const input = () => document.querySelector('input[name="withdraw"]') as HTMLInputElement | null;
  expect(input()!.placeholder).toBe('輸入金額');
  expect(detail()!.textContent).toContain('最多可提款 $80.25');
  await act(async () => button('全部').click());
  expect(input()!.value).toBe('80.25');
  // More than the account can withdraw: the button stays off.
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '81'); input()!.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('提款').disabled).toBe(true);
  items = [item({ pendingTransfer: { id: '88888888-8888-4888-8888-888888888888', direction: 'to_main', status: 'accepted', amount: '12.5' } })];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(input()).toBeNull();
  expect(document.querySelector('[data-testid="transfer-pending"]')!.textContent).toBe('轉帳處理中，完成後可再次提款');
});

it('reads the account again once a transfer settles, so the equity moves without a reload', async () => {
  items = [item({ pendingTransfer: { id: '88888888-8888-4888-8888-888888888888', direction: 'to_main', status: 'accepted', amount: '12.5' } })];
  await render();
  state.refetch.mockClear();
  items = [item()];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(state.refetch).toHaveBeenCalled();
});

it('every action ends in a toast: success, or the failure in words with no raw code', async () => {
  const { ToastProvider } = await import('@/components/ui/toast');
  const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}><ToastProvider><LiveCopies /></ToastProvider></I18nProvider></QueryClientProvider>));
  await settle(); await openCard(0);
  const toasts = () => [...document.querySelectorAll('[data-testid="toasts"] [role="status"][data-type]')].map(el => ({ type: el.getAttribute('data-type'), text: el.textContent }));
  state.post.mockResolvedValueOnce({ id: '33333333-3333-4333-8333-333333333333', accountId: liveAccount.id, strategyId: liveAccount.strategyId, coin: 'BTC', state: 'requested', reason: null, orders: 0,
    createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() });
  await act(async () => button('平倉').click()); await settle();
  expect(toasts()).toContainEqual({ type: 'success', text: '已送出 BTC 平倉' });
  state.post.mockRejectedValueOnce(new ApiError(409, 'Conflict', { code: 'funding_pending' }));
  await act(async () => button('平倉').click()); await settle();
  const failed = toasts().find(t => t.type === 'error')!;
  expect(failed.text).toContain('已有一筆入金正在處理');
  expect(failed.text).not.toMatch(/funding_pending|409|Conflict/);
});

it('PnL is equity less net deposits: a 10 USDC return is not a loss, and an unknown ledger shows — (audit 2026-10-07 P0-2)', async () => {
  funds = [deposit(100), deposit(10, { counterparty: `0x${'11'.repeat(20)}`, time: new Date(liveNow).toISOString() })];
  await render('en', { open: false });
  // 97.50 equity on 90 net deposits: +7.50 (+8.33%), not -2.50.
  expect(cards()[0]!.textContent).toContain('+$7.50'); expect(cards()[0]!.textContent).toContain('8.33%');
  expect(cards()[0]!.textContent).not.toContain('-$2.50');
  // A transfer still on its way: no figure until it settles.
  funds = [deposit(100), deposit(10, { counterparty: `0x${'11'.repeat(20)}`, status: 'prepared' })];
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(cards()[0]!.textContent).toContain('—');
  expect(cards()[0]!.textContent).not.toContain('$');
});

it('a mainnet copy\'s sheet never says 測試網: its own hint, the price refusal in plain words, no setup hint (audit 2026-10-07 P0-3)', async () => {
  items = [item({ network: 'mainnet', lastRefusal: { reason: 'live_source_price_deviation', at: new Date(liveNow).toISOString() } })];
  // On a mainnet deployment (a mainnet copy on testnet is another network's).
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live/portfolio' ? { network: 'mainnet', automaticExecution: true, items }
    : path.startsWith('/me/funds/history') ? { items: funds, nextCursor: null } : null);
  await render('zh-TW');
  expect(detail()!.textContent).not.toContain('測試網');
  expect(detail()!.textContent).toContain(catalogs['zh-TW'].liveCopyUi.enabledHint);
  expect(detail()!.textContent).toContain('最近略過的訊號：價格與交易員成交價差距過大');
  // A testnet copy also distinguishes authorization from verified execution.
  await act(async () => root.unmount()); root = createRoot(container);
  items = [item({ network: 'testnet' })];
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live/portfolio' ? { network: 'testnet', automaticExecution: true, items }
    : path.startsWith('/me/funds/history') ? { items: funds, nextCursor: null } : null);
  await render('zh-TW');
  expect(detail()!.textContent).toContain(catalogs['zh-TW'].liveCopyUi.enabledHint);
  expect(detail()!.textContent).toContain(catalogs['zh-TW'].liveCopyUi.executionUnknown);
  // The settings' referral hint and the delete-account texts are network-free.
  const zh = catalogs['zh-TW'];
  for (const line of [zh.referral.copyingHint, zh.deleteAccount.keptBody, zh.deleteAccount.blockers.copies_active]) expect(line).not.toContain('測試網');
});

it('a refused withdrawal says why once, in the confirm sheet (no toast too), and closing the sheet clears it (audit 2026-10-07 P1-5)', async () => {
  const { ToastProvider } = await import('@/components/ui/toast');
  const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}><ToastProvider><LiveCopies /></ToastProvider></I18nProvider></QueryClientProvider>));
  await settle(); await openCard(0);
  const toasts = () => [...document.querySelectorAll('[data-testid="toasts"] [role="status"][data-type]')].map(el => el.textContent);
  state.post.mockRejectedValue(new ApiError(409, 'Conflict', { code: 'no_free_collateral' }));
  await act(async () => {
    const input = document.querySelector('input[name="withdraw"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '5'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('提款').click()); await settle();
  await act(async () => sheetButton('確認提款')!.click()); await settle();
  const line = '目前沒有可提款的閒置資金，資金正用於持倉保證金。';
  expect(sheet()!.textContent).toContain(line);
  expect(toasts().filter(text => text?.includes(line) || text?.includes('發生錯誤'))).toEqual([]);
  await act(async () => sheetButton('取消')!.click()); await settle();
  expect(sheet()).toBeNull();
  expect(detail()!.textContent).not.toContain(line);
  expect(detail()!.textContent).not.toContain('發生錯誤');
});

it('keeps a copy of the previous network out of 跟單中 and 我的資金: a folded group, its network tagged, no withdraw or stop (Stage A1)', async () => {
  // The deployment is mainnet; the old testnet copy still holds 79 USDC.
  items = [item({ strategyId: 77, network: 'testnet', accountId: 'acct-old', accountAddress: `0x${'e0'.repeat(20)}` })];
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live/portfolio' ? { network: 'mainnet', automaticExecution: true, items }
    : path.startsWith('/me/funds/history') ? { items: funds, nextCursor: null } : null);
  const onEquity = vi.fn();
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}><LiveCopies onEquity={onEquity} empty={<p data-testid="no-copies">none</p>} /></I18nProvider></QueryClientProvider>));
  await settle();
  expect(cards()).toHaveLength(0);
  expect(container.querySelector('[data-testid="no-copies"]')).not.toBeNull();
  expect(onEquity.mock.calls.filter(([id, equity]) => id === 77 && equity !== null)).toEqual([]);
  const group = container.querySelector('[data-testid="previous-network"]')!;
  expect(group.querySelector('summary')!.textContent).toBe('先前網路的跟單（1）');
  const old = group.querySelector<HTMLButtonElement>('[data-testid="previous-copy-card"]')!;
  expect(old.querySelector('[data-mode="testnet"]')!.textContent).toContain('測試網');
  await act(async () => old.click()); await settle();
  expect(detail()!.textContent).toContain('先前網路的跟單：僅保留紀錄');
  expect(detail()!.querySelector('input[name="withdraw"]')).toBeNull();
  expect(detail()!.querySelector('[data-testid="stop"]')).toBeNull();
  expect(detail()!.textContent).not.toContain('正在 Hyperliquid 測試網跟隨');
});
