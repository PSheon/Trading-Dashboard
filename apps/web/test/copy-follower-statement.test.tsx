// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CopyExecutionAccount, CopyFollowerStatement } from '@trading-dashboard/shared/contracts';
import { CopyFollowerStatementSettings } from '@/components/settings/copy-follower-statement';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { LOCALES, type Locale } from '@/i18n/config';
import { followerSnapshot } from './copy-follower-snapshot-fixtures';
import { activityPage } from './copy-follower-activity-fixtures';
import { flush as flushFor, settleQueries } from './query-settle';
const state = vi.hoisted(() => ({ get: vi.fn(), activity: vi.fn(), snapshot: vi.fn(), status: 'signedIn', mode: 'privy', identity: 'owner', session: '1' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ ...state, wallet: null }) }));
vi.mock('@/lib/api', () => ({ api: { get: (path: string, ...args: unknown[]) => path.endsWith('/snapshot') ? state.snapshot(path, ...args) : path.includes('/activity?') ? state.activity(path, ...args) : state.get(path, ...args) }, sessionKey: () => state.session }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const account: CopyExecutionAccount = { id: 'account', strategyId: 9, network: 'testnet', state: 'ready', address: `0x${'22'.repeat(20)}`, issue: null, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' };
const other: CopyExecutionAccount = { ...account, id: 'other', strategyId: 10, address: `0x${'33'.repeat(20)}` };
function statement(a = account): CopyFollowerStatement { return { accountId: a.id, strategyId: a.strategyId, network: a.network, accountAddress: a.address!, token: 'USDC', receiptCount: '2', actual: { realizedPnl: '12.5', exchangeFee: '0.000001', builderFee: '-0.25', funding: '-1', tradingCashDelta: '11.250001' }, quarantine: { blocked: false, reason: null }, coverage: { historicalCompleteness: 'unproven', scannedThrough: null, unresolvedWindows: null, issue: null, updatedAt: null }, latestReceipts: [{ key: 'fill', kind: 'fill', coin: 'BTC', time: '2026-10-03T00:00:00Z', attribution: 'execution', executionKey: 'execution' }, { key: 'funding', kind: 'funding', coin: 'BTC', time: '2026-10-03T00:00:01Z', attribution: 'account', executionKey: null }] }; }
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { status: 'signedIn', mode: 'privy', identity: 'owner', session: '1' }); state.get.mockReset().mockResolvedValue(statement()); state.snapshot.mockReset().mockImplementation((path: string) => { const a = path.includes('/other/') ? other : account; return Promise.resolve({ mode: 'actual', network: 'testnet', accountId: a.id, strategyId: a.strategyId, accountAddress: a.address, status: 'unavailable', observation: null, reason: 'not_observed' }); }); state.activity.mockReset().mockImplementation((path: string) => Promise.resolve({ ...activityPage(path.includes('/other/') ? other : account), items: [], hasMore: false, previousCursor: null })); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
// Waits for the statement, activity and snapshot reads to answer; flush() is a
// plain wait for the tests that hold a statement read open.
const settle = () => settleQueries(client, { ms: 20 });
const flush = () => flushFor(20);
async function render(accounts = [account, other], locale: Locale = 'en', wait: () => Promise<void> = settle) { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><CopyFollowerStatementSettings accounts={accounts}/></I18nProvider></QueryClientProvider>)); await wait(); }
async function select(id = account.id, wait: () => Promise<void> = settle) { await act(async () => { const el = container.querySelector('select')!; el.value = id; el.dispatchEvent(new Event('change', { bubbles: true })); }); await wait(); }
it('requires account selection and displays exact booked components with financial limits and accessible details', async () => {
  await render(); expect(state.get).not.toHaveBeenCalled(); await select(); expect(state.get).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('+0.000001 USDC'); expect(container.textContent).toContain('-0.25 USDC'); expect(container.textContent).toContain('-1 USDC'); expect(container.textContent).toContain('+11.250001 USDC');
  expect(container.textContent).toContain('separate from your virtual paper balance'); expect(container.textContent).toContain('does not equal account equity'); expect(container.textContent).toContain('excludes deposits and withdrawals'); expect(container.textContent).toContain('Historical completeness is unproven');
  expect(container.textContent).toContain('Scan progress unknown'); expect(container.textContent).toContain('Unresolved scan windows: unknown');
  const details = container.querySelector('details')!; expect(details.open).toBe(false); expect(details.querySelector('summary')?.textContent).toContain('Recent receipts');
  expect(details.textContent).toContain('BTC'); expect(details.textContent).toContain('Attributed to an execution'); expect(details.textContent).toContain('Account receipt'); expect(details.querySelectorAll('th')).toHaveLength(4);
  const el = container.querySelector('select')!; expect(container.querySelector(`label[for="${el.id}"]`)).not.toBeNull();
});
it('mounts separate actual activity only for the selected master and resets both readers on session change', async () => {
  await render(); expect(state.activity).not.toHaveBeenCalled();
  const page = activityPage(account); page.hasMore = false; page.items[0] = { ...page.items[0], kind: 'fill', attribution: 'execution', executionKey: 'execution', oid: '7', tid: '1', side: 'B', size: '0.01', price: '100', realizedPnl: '12.5', exchangeFee: '0.000001', builderFee: '-0.25', tradingCashDelta: '12.250001' }; page.items[1] = { ...page.items[1], kind: 'funding', attribution: 'account', executionKey: null, hash: `0x${'44'.repeat(32)}`, funding: '-1', tradingCashDelta: '-1' };
  state.activity.mockResolvedValue(page); await select();
  expect(state.activity.mock.calls[0][0]).toBe('/me/copy/execution-wallets/account/activity?limit=20'); expect(container.textContent).toContain('Actual follower statement'); expect(container.textContent).toContain('Actual follower activity'); expect(container.textContent).toContain('+12.250001 USDC');
  state.session = 'changed'; await render(); expect(container.querySelector('select')?.value).toBe(''); expect(container.textContent).not.toContain('+12.250001 USDC'); expect(container.textContent).not.toContain('Actual follower activity');
});
it('mounts exact selected-account observations separately from booked cash delta and removes them on session change', async () => {
  await render(); expect(state.snapshot).not.toHaveBeenCalled(); state.snapshot.mockResolvedValue(followerSnapshot(account)); await select();
  expect(state.snapshot.mock.calls[0][0]).toBe('/me/copy/execution-wallets/account/snapshot'); expect(container.textContent).toContain('100 USDC'); expect(container.textContent).toContain('+11.250001 USDC'); expect(container.textContent).toContain('Actual account observation');
  state.session = 'changed'; await render(); expect(container.textContent).not.toContain('100 USDC'); expect(container.textContent).not.toContain('Actual account observation'); expect(container.querySelector('select')?.value).toBe('');
});
it('removes the previous account amounts immediately and ignores a late previous account response', async () => {
  let finish!: (value: CopyFollowerStatement) => void; state.get.mockImplementation((path: string) => path.includes('/account/') ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ...statement(other), actual: { realizedPnl: '7', exchangeFee: '0', builderFee: '0', funding: '0', tradingCashDelta: '7' } }));
  await render(); await select(account.id, flush); expect(container.textContent).toContain('Loading statement'); await select(other.id, flush); expect(container.textContent).toContain('+7 USDC');
  await act(async () => finish(statement())); await settle(); expect(container.textContent).not.toContain('+12.5 USDC'); expect(container.textContent).toContain('+7 USDC');
});
it('hides already displayed data on selection change while the new account is loading', async () => {
  await render(); await select(); expect(container.textContent).toContain('+12.5 USDC'); state.get.mockImplementation(() => new Promise(() => {})); await select(other.id, flush); expect(container.textContent).not.toContain('+12.5 USDC'); expect(container.textContent).toContain('Loading statement');
});
it.each(['identity', 'session'] as const)('resets selection and discards private late data after %s changes', async (field) => {
  let finish!: (value: CopyFollowerStatement) => void; state.get.mockImplementation(() => new Promise((resolve) => { finish = resolve; })); await render(); await select(account.id, flush); state[field] = 'changed'; await render([account, other], 'en', flush); await act(async () => finish(statement())); await settle(); expect(container.textContent).not.toContain('+12.5 USDC'); expect(container.querySelector('select')?.value).toBe(''); expect(state.get).toHaveBeenCalledOnce();
});
it('discards account data when the current list removes the selected account', async () => { await render(); await select(); await render([other]); expect(container.textContent).not.toContain('+12.5 USDC'); expect(state.get).toHaveBeenCalledOnce(); });
it.each(['address', 'strategyId', 'network'] as const)('does not reuse cached statement totals after same-id %s changes', async (field) => {
  await render(); await select(); state.get.mockImplementation(() => new Promise(() => {}));
  const updated = { ...account, [field]: field === 'address' ? other.address : field === 'strategyId' ? 11 : 'mainnet' } as CopyExecutionAccount;
  await render([updated], 'en', flush); expect(container.textContent).not.toContain('+12.5 USDC'); expect(container.textContent).toContain('Loading statement'); expect(state.get).toHaveBeenCalledTimes(2);
});
it('labels a known empty ledger without claiming no activity or complete scan coverage', async () => {
  const zero = statement(); zero.receiptCount = '0'; zero.latestReceipts = []; for (const key of Object.keys(zero.actual) as (keyof typeof zero.actual)[]) zero.actual[key] = '0';
  state.get.mockResolvedValue(zero); await render(); await select(); expect(container.textContent).toContain('0 USDC'); expect(container.textContent).toContain('This does not prove no exchange activity'); expect(container.textContent).toContain('Scan progress unknown');
});
it('rejects a mismatched account wire response instead of showing its totals', async () => {
  state.get.mockResolvedValue(statement(other)); await render(); await select(); expect(container.textContent).toContain('Statement unavailable'); expect(container.textContent).not.toContain('+12.5 USDC');
});
it('removes stale totals after an unsuccessful background read', async () => {
  await render(); await select(); state.get.mockRejectedValue(new Error('private detail'));
  await act(async () => { await client.invalidateQueries(); }); await settle(); expect(container.textContent).toContain('Statement unavailable'); expect(container.textContent).not.toContain('+12.5 USDC');
});
it('shows safe unavailable errors with manual retry and never presents failed reads as zero', async () => {
  state.get.mockRejectedValue(new Error('Bearer private-token')); await render(); await select(); expect(container.textContent).toContain('Statement unavailable'); expect(container.textContent).not.toContain('private-token'); expect(container.textContent).not.toContain('0 USDC'); expect(state.get).toHaveBeenCalledOnce();
  state.get.mockResolvedValue(statement()); await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click()); await settle(); expect(state.get).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('+12.5 USDC');
});
it('shows known quarantine and unresolved windows without claiming complete history or exposing raw issues', async () => {
  state.get.mockResolvedValue({ ...statement(), quarantine: { blocked: true, reason: 'private reason' }, coverage: { historicalCompleteness: 'unproven', scannedThrough: '2026-10-03T00:00:01Z', unresolvedWindows: 3, issue: 'secret issue', updatedAt: '2026-10-03T00:00:02Z' } }); await render(); await select(); expect(container.textContent).toContain('Account quarantined'); expect(container.textContent).toContain('Unresolved scan windows: 3'); expect(container.textContent).toContain('A scan issue is unresolved'); expect(container.textContent).not.toContain('private reason'); expect(container.textContent).not.toContain('secret issue');
});
it.each([{ status: 'signedOut' }, { mode: 'fixture' }])('does not fetch real ledger data for %j', async (change) => { Object.assign(state, change); await render(); expect(state.get).not.toHaveBeenCalled(); expect(container.querySelector('section')).toBeNull(); });
it.each(LOCALES)('renders translated real-money caveats and labelled controls in %s', async (locale) => { await render([account], locale); await select(); expect(container.textContent).not.toContain('copyFollowerStatement.'); expect(container.querySelector('section')?.getAttribute('aria-label')).toBeTruthy(); expect(container.querySelector('details summary')).not.toBeNull(); });
