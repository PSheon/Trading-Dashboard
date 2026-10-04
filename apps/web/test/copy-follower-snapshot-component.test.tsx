// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CopyFollowerSnapshot } from '@/components/copy/copy-follower-snapshot';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { LOCALES, type Locale } from '@/i18n/config';
import { activityAccount as account, otherActivityAccount as other } from './copy-follower-activity-fixtures';
import { followerSnapshot } from './copy-follower-snapshot-fixtures';
import { flush as flushFor, settleQueries } from './query-settle';
const state = vi.hoisted(() => ({ get: vi.fn(), status: 'signedIn', mode: 'privy', identity: 'owner', session: '1' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ ...state, wallet: null }) }));
vi.mock('@/lib/api', () => ({ api: { get: state.get }, sessionKey: () => state.session }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { status: 'signedIn', mode: 'privy', identity: 'owner', session: '1' }); state.get.mockReset().mockResolvedValue(followerSnapshot()); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); });
// Waits for the snapshot read to answer (advancing fake timers when on); flush() is
// a plain wait for the tests that hold a read open.
const settle = () => settleQueries(client, { ms: vi.isFakeTimers() ? 25 : 20 });
const flush = () => flushFor(vi.isFakeTimers() ? 25 : 20);
async function render(a: typeof account | null = account, locale: Locale = 'en', wait: () => Promise<void> = settle) { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><CopyFollowerSnapshot account={a}/></I18nProvider></QueryClientProvider>)); await wait(); }
it('shows actual observed equity with no fake ROI or capital balance and collapsible venue data', async () => {
  await render(); expect(container.textContent).toContain('100 USDC'); expect(container.textContent).toContain('Fresh observation'); expect(container.textContent).toContain('Paper money is separate');
  expect(container.textContent).toContain('historical baseline and capital flows are unproven'); expect(container.textContent).toContain('do not approve trading or transfers'); expect(container.textContent).not.toContain('0%');
  expect(container.querySelector('details')?.open).toBe(false); expect(container.textContent).toContain('Complete balance/order coverage: 1 venues');
});
it('renders exact positions and remaining orders only when their accessible details are opened', async () => {
  const v = followerSnapshot();
  v.positions = [{ coin: 'BTC', dex: '', asset: 0, sizeDecimals: 2, size: '-1', entryPrice: '100', positionValue: '100', unrealizedPnl: '-0.000000000000000001', marginUsed: '10', leverage: 10, leverageType: 'cross', maxLeverage: 20, fundingSinceOpen: '0', fundingSinceChange: '0' }];
  v.restingOrders = [{ coin: 'BTC', dex: '', asset: 0, oid: '7', side: 'B', limitPrice: '100', remainingSize: '0.25', originalSize: '1', notionalUsd: '25', reduceOnly: true, timestamp: v.asOf.completedAt, cloid: null }];
  Object.assign(v.metrics, { marginUsed: '10', exposureUsd: '100', grossRestingExposureUsd: '25', unrealizedPnl: '-0.000000000000000001' }); Object.assign(v.dexes[0], { marginUsed: '10', exposureUsd: '100', crossMarginUsed: '10', crossExposureUsd: '100' });
  state.get.mockResolvedValue(v); await render(); const panels = [...container.querySelectorAll('details')]; expect(panels.every(d => !d.querySelector('ul'))).toBe(true);
  for (const panel of panels) { await act(async () => { panel.open = true; panel.dispatchEvent(new Event('toggle')); }); } await settle();
  expect(container.textContent).toContain('-0.000000000000000001 USDC'); expect(container.textContent).toContain('Cross margin'); expect(container.textContent).toContain('0.25'); expect(container.textContent).toContain('Reduce only'); expect(panels[0].querySelectorAll('li')).toHaveLength(1);
});
it('expires at the original deadline without waiting for the next periodic clock tick', async () => {
  vi.useFakeTimers(); state.get.mockResolvedValue(followerSnapshot(account, Date.now())); await render(); await act(async () => { await vi.advanceTimersByTimeAsync(5001); }); expect(container.textContent).not.toContain('Fresh observation');
});
it('hides stale money after a failed refresh and offers only a read retry without raw errors', async () => {
  await render(); state.get.mockRejectedValue(new Error('private-token')); await act(async () => { await client.invalidateQueries(); }); await settle(); expect(container.textContent).not.toContain('100 USDC'); expect(container.textContent).not.toContain('private-token'); expect(container.textContent).toContain('Account observation unavailable');
  state.get.mockResolvedValue(followerSnapshot()); await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry')!.click()); await settle(); expect(container.textContent).toContain('100 USDC');
});
it('expires freshness while idle and stays stale on wake even if the local wall clock moves backwards', async () => {
  vi.useFakeTimers(); const start = Date.now(); state.get.mockResolvedValue(followerSnapshot(account, start)); await render(); expect(container.textContent).toContain('Fresh observation');
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(container.textContent).toContain('Last observation stale'); expect(container.textContent).not.toContain('Fresh observation');
  vi.setSystemTime(start - 60000); await act(async () => window.dispatchEvent(new Event('focus'))); expect(container.textContent).not.toContain('Fresh observation');
});
it('does not refresh a delayed observation lease when a slow GET arrives and the client clock is behind the server', async () => {
  vi.useFakeTimers(); const original = followerSnapshot(account, Date.now() + 600000); let finish!: (v: unknown) => void;
  state.get.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render(account, 'en', flush); await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); await act(async () => finish(original)); await settle();
  expect(container.textContent).toContain('Last observation stale'); expect(container.textContent).not.toContain('Fresh observation');
});
it('renders explicit unavailable and failed-refresh states without zero placeholders', async () => {
  const v = followerSnapshot(); state.get.mockResolvedValue({ mode: 'actual', network: 'testnet', accountId: account.id, strategyId: account.strategyId, accountAddress: account.address, status: 'unavailable', observation: null, reason: 'not_observed' }); await render();
  expect(container.textContent).toContain('Balances are unknown'); expect(container.textContent).not.toContain('0 USDC');
  v.freshness = 'stale'; v.lastReadIssue = 'source_unavailable'; state.get.mockResolvedValue(v); await act(async () => { await client.invalidateQueries(); }); await settle(); expect(container.textContent).toContain('showing the stale observation'); expect(container.textContent).not.toContain('Fresh observation');
});
it('hides previous account values while switching and refuses a late original response', async () => {
  let finish!: (v: unknown) => void; state.get.mockImplementation((path: string) => path.includes('/account/') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(followerSnapshot(other)));
  await render(account, 'en', flush); await render(other, 'en', flush); await act(async () => finish(followerSnapshot())); await settle(); expect(container.textContent).toContain(other.address!); expect(container.textContent).not.toContain(account.address!);
});
it('keeps mainnet booked history separate and never asks for a fabricated testnet snapshot', async () => { await render({ ...account, network: 'mainnet' }); expect(container.textContent).toContain('Only testnet observations are supported'); expect(state.get).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('0 USDC'); });
it.each([{ status: 'signedOut' }, { mode: 'fixture' }])('does not render or fetch actual observations for %j', async change => { Object.assign(state, change); await render(); expect(container.querySelector('section')).toBeNull(); expect(state.get).not.toHaveBeenCalled(); });
it.each(LOCALES)('renders localized observed/unproven distinctions in %s', async locale => { await render(account, locale); expect(container.textContent).not.toContain('copyFollowerSnapshot.'); expect(container.querySelector('section')?.getAttribute('aria-label')).toBeTruthy(); });
