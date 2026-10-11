// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveCopies } from '@/components/copy/live-copies';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveAccount, liveMandate, liveNow } from './copy-live-fixtures';
import { settleQueries } from './query-settle';

/**
 * An actual copy's sheet has the paper detail's comparison (CopyCompare) and
 * exposure (ExposurePanel), the same components (parity review D13/D14).
 * Only real data: the leader's Hyperliquid portfolio, the copy account's
 * observed positions; an actual copy has no recorded equity history
 * (copy_equity_snapshots holds paper copies only), so 你的跟單 stays empty
 * and "—", and its paper-only performance endpoint is never asked.
 */
const state = vi.hoisted(() => ({ get: vi.fn(), snapshot: null as unknown }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: 'owner@email', wallet: { address: `0x${'11'.repeat(20)}` } }) }));
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: { get: state.get, patch: vi.fn(), post: vi.fn() }, sessionKey: () => '1' }));
vi.mock('@/lib/copy-execution-wallets', () => ({ useExecutionWallets: () => ({ data: { accounts: [liveAccount] } }) }));
vi.mock('@/lib/copy-live', () => ({ useLiveCopyOverview: () => ({ data: { mandates: [{ ...liveMandate, state: 'active' }], strategies: [] } }) }));
vi.mock('@/lib/copy-follower-snapshot', () => ({ useCopyFollowerSnapshot: () => ({ data: state.snapshot, refetch: vi.fn() }) }));
vi.mock('@/components/copy/copy-live-stop', () => ({ LiveCopyStopAction: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/portfolio', useSearchParams: () => new URLSearchParams() }));

const leader = `0x${'44'.repeat(20)}`;
const item = (over: Record<string, unknown> = {}) => ({ strategyId: liveAccount.strategyId, leaderAddress: leader, sourceNetwork: 'mainnet', network: 'testnet', budgetUsd: '100',
  status: 'active', stage: 'active', createdAt: new Date(liveNow).toISOString(), accountId: liveAccount.id, accountAddress: liveAccount.address,
  mandate: { id: liveMandate.id, state: 'active', revision: 3 }, stop: null, pendingTransfer: null, lastRefusal: null, ...over });
const observed = { status: 'observed', metrics: { perpEquity: '97.5', withdrawable: '80.25', unrealizedPnl: '0.5' }, restingOrders: [],
  positions: [{ coin: 'BTC', size: '0.19', dex: '', asset: 0, sizeDecimals: 2, entryPrice: '100', positionValue: '19', unrealizedPnl: '0.5', marginUsed: '1.9', leverage: 10,
    leverageType: 'cross', maxLeverage: 20, fundingSinceOpen: '0', fundingSinceChange: '0' }] };
// The leader's perp account around the copy's start: +$5 on $100 of net deposits.
const leaderPortfolio = { pnl: [[liveNow - 3_600_000, 0], [liveNow + 3_600_000, 5]], accountValue: [[liveNow - 3_600_000, 100], [liveNow + 3_600_000, 105]],
  cumulativeReturn: [[liveNow - 3_600_000, 0], [liveNow + 3_600_000, 0.05]] };
// The copy's own recorded history (copy_equity_snapshots of an actual copy): +$2 on $100 deposited.
const performance = (points: unknown[]) => ({ strategyId: liveAccount.strategyId, mode: 'actual', network: 'testnet', window: '7d', from: new Date(liveNow - 7 * 86_400_000).toISOString(),
  to: new Date(liveNow + 3_600_000).toISOString(), points, todayPnl: null, coverage: { firstSnapshotAt: null, lastSnapshotAt: null, complete: false } });
let mine: unknown[] = [];
let root: Root, container: HTMLDivElement, client: QueryClient, items: ReturnType<typeof item>[];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  items = [item()]; state.snapshot = observed; mine = [];
  state.get.mockReset().mockImplementation(async (path: string) => path === '/me/copy/live/portfolio' ? { network: 'testnet', automaticExecution: true, items }
    : path.startsWith('/me/funds/history') ? { items: [], nextCursor: null }
    : path.startsWith(`/traders/${leader}/portfolio`) ? leaderPortfolio
    : path.startsWith(`/me/copy/strategies/${liveAccount.strategyId}/performance`) ? performance(mine) : null);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
const settle = () => settleQueries(client, { ms: 15 });
async function open() {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><LiveCopies /></I18nProvider></QueryClientProvider>));
  await settle();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="live-copy-card"]')!.click()); await settle();
  return document.querySelector('[data-testid="live-copy-sheet"]') as HTMLElement;
}
const asked = (prefix: string) => state.get.mock.calls.filter(([path]) => String(path).startsWith(prefix));

it("compares an actual copy with its trader over the same period: the trader's real figures, the copy's own recorded history", async () => {
  mine = [{ time: new Date(liveNow + 60_000).toISOString(), equity: 100, totalPnl: 0, netDeposits: 100, exposureUsd: 0 },
    { time: new Date(liveNow + 3_600_000).toISOString(), equity: 102, totalPnl: 2, netDeposits: 100, exposureUsd: 19 }];
  const sheet = await open();
  const compare = sheet.querySelector('[data-testid="copy-compare"]');
  expect(compare).not.toBeNull();
  // The leader's Hyperliquid perp portfolio (mainnet source), its change since the copy started.
  expect(asked(`/traders/${leader}/portfolio`).length).toBeGreaterThan(0);
  expect(asked(`/me/copy/strategies/${liveAccount.strategyId}/performance`).length).toBeGreaterThan(0);
  const [yours, theirs] = [...compare!.querySelectorAll('dl > div')];
  expect(theirs!.textContent).toContain('+5%');
  expect(theirs!.textContent).toContain('+$5.00');
  expect(yours!.textContent).toContain('+$2.00');
  expect(sheet.textContent).not.toContain('No chart data yet');
});

it("an actual copy with no recorded history yet says —, never 0", async () => {
  const sheet = await open();
  const [yours] = [...sheet.querySelector('[data-testid="copy-compare"]')!.querySelectorAll('dl > div')];
  expect(yours!.textContent).toContain('—');
  expect(yours!.textContent).not.toContain('$0.00');
  expect(sheet.textContent).toContain('No chart data yet');
});

it("shows the copy account's exposure from its observed positions (the paper detail's panel)", async () => {
  const sheet = await open();
  expect(sheet.textContent).toContain('Direction');
  expect(sheet.textContent).toContain('By Asset');
  // Gross notional is the observed position value; leverage = 19 ÷ 97.5.
  expect(sheet.textContent).toContain('$19.00');
  expect(sheet.textContent).toContain('0.2×');
});

it("a copy of a testnet trader never reads the trader's figures from the mainnet portfolio", async () => {
  items = [item({ sourceNetwork: 'testnet' })];
  const sheet = await open();
  const compare = sheet.querySelector('[data-testid="copy-compare"]');
  expect(compare).not.toBeNull();
  expect(asked('/traders/')).toHaveLength(0);
  const [, theirs] = [...compare!.querySelectorAll('dl > div')];
  expect(theirs!.textContent).toContain('—');
});

it('an unobserved account has no exposure figures (no zero)', async () => {
  state.snapshot = null;
  const sheet = await open();
  expect(sheet.textContent).not.toContain('By Asset');
  expect(sheet.textContent).not.toContain('0.0×');
});
