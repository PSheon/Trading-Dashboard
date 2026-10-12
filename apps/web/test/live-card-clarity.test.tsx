// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveCopies } from '@/components/copy/live-copies';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import type { LiveCopyItem } from '@/lib/copy-live-portfolio';
import { liveAccount, liveMandate, liveOwner } from './copy-live-fixtures';

const state = vi.hoisted(() => ({ items: [] as LiveCopyItem[], snapshot: null as unknown, flows: [] as unknown[], search: '', setupReads: [] as (string | null)[], setup: null as unknown }));
const idle = { isPending: false, reset() {}, mutate: vi.fn(), mutateAsync: vi.fn() };
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: 'test-owner', wallet: { address: liveOwner } }) }));
vi.mock('@/lib/copy-live-portfolio', async () => ({ ...(await vi.importActual<typeof import('@/lib/copy-live-portfolio')>('@/lib/copy-live-portfolio')),
  useLiveCopyPortfolio: () => ({ data: { network: 'testnet', items: state.items }, enabled: true }),
  useLiveCopyPortfolioActions: () => ({ transfer: idle, close: idle, cancelTransfer: idle }),
}));
vi.mock('@/lib/copy-live-setup', async () => ({ ...(await vi.importActual<typeof import('@/lib/copy-live-setup')>('@/lib/copy-live-setup')),
  useLiveCopyDeployment: () => ({ network: 'testnet', available: true }),
  useLiveCopySetup: (id: string | null) => { state.setupReads.push(id); return { data: state.setup, retrying: false, failure: null }; },
  useLiveCopySetupActions: () => ({ cancel: idle }),
}));
vi.mock('@/lib/copy-execution-wallets', () => ({ useExecutionWallets: () => ({ data: { accounts: [liveAccount] } }) }));
vi.mock('@/lib/copy-live', () => ({ useLiveCopyOverview: () => ({ data: { network: 'testnet', mandates: [liveMandate], strategies: [] } }) }));
vi.mock('@/lib/copy-follower-snapshot', () => ({ useCopyFollowerSnapshot: () => ({ data: state.snapshot, refetch: async () => undefined }) }));
vi.mock('@/lib/funds', () => ({ useFundsHistory: () => ({ data: { pages: [{ items: state.flows }] }, hasNextPage: false }) }));
vi.mock('@/components/copy/copy-portfolio', () => ({ useLeaders: () => new Map() }));
vi.mock('@/components/copy/copy-live-stop', () => ({ LiveCopyStopAction: () => null }));
vi.mock('@/components/copy/live-copy-actions', () => ({ LiveCopyActions: () => null }));
vi.mock('@/components/copy/copy-compare', () => ({ CopyCompare: () => null }));
// The real activity child and its query provider are covered by live-copy-activity-entry.test.tsx.
vi.mock('@/components/copy/copy-follower-activity', () => ({ CopyFollowerActivity: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/zh-TW/portfolio', useSearchParams: () => new URLSearchParams(state.search) }));
let root: Root, container: HTMLDivElement;
const id = '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c';
const item = (extra: Partial<LiveCopyItem> = {}): LiveCopyItem => ({ strategyId: liveAccount.strategyId, leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'testnet', network: 'testnet', budgetUsd: '50', status: 'active', stage: 'active', createdAt: '2026-10-08T00:00:00Z',
  accountId: liveAccount.id, accountAddress: liveAccount.address, mandate: { id: liveMandate.id, state: 'active', revision: 1 }, stop: null, pendingTransfer: null, lastRefusal: null, ...extra });
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.items = [item()]; state.snapshot = null; state.flows = []; state.search = ''; state.setupReads = []; state.setup = null; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.replaceChildren(); });
async function render() { await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}><LiveCopies /></I18nProvider>)); }
const card = () => container.querySelector<HTMLButtonElement>('[data-testid="live-copy-card"]')!;
async function openCard() { await act(async () => card().click()); }
it('labels closing, returning and credited return separately on cards', async () => {
  state.items = [item({ stage: 'stopping', stop: { id, state: 'closing', issue: null, revision: 1 } })];
  await render(); expect(card().textContent).toContain('平倉中');
  state.items = [item({ stage: 'sweeping', sweep: { amount: '49', status: 'accepted' } })];
  await render(); expect(card().textContent).toContain('返還中'); expect(card().textContent).not.toContain('返還已入帳');
  state.items = [item({ stage: 'stopped', status: 'stopped', sweep: { amount: '49', status: 'credited' } })];
  await render(); expect(card().textContent).toContain('返還已入帳');
});
it('never claims a stopped return was credited from accepted or unknown evidence', async () => {
  for (const status of ['accepted', 'unknown'] as const) {
    state.items = [item({ stage: 'stopped', status: 'stopped', sweep: { amount: '49', status } })];
    await render(); expect(card().textContent).toContain('返還中'); expect(card().textContent).not.toContain('返還已入帳');
  }
});
const sheet = () => document.querySelector<HTMLElement>('[data-testid="live-copy-sheet"]')!;
const observedAt = Date.parse('2026-10-08T01:00:00Z');
const observed = { status: 'observed', metrics: { perpEquity: '49', withdrawable: '49' }, positions: [], asOf: { observedAt } };
const transfer = { id: 'op-1', direction: 'to_account', status: 'accepted', amount: '10' } as LiveCopyItem['pendingTransfer'];
// Each reason the PnL is unknown: the card says 待確認 only; the sheet says which.
const unknownCases: [string, () => void, string][] = [
  ['observation', () => { state.items = [item()]; state.snapshot = null; }, '帳戶觀察尚未確認，損益未知'],
  ['history', () => { state.items = [item()]; state.snapshot = observed; }, '資金紀錄尚未完整核對，損益未知'],
  ['transfer', () => { state.items = [item({ pendingTransfer: transfer })]; state.snapshot = observed; }, '資金移轉狀態待確認，損益未知'],
  ['funding', () => { state.items = [item({ stage: 'funding' })]; state.snapshot = null; }, '入金尚未確認入帳，損益待確認'],
  ['stopping', () => { state.items = [item({ stage: 'stopping' })]; state.snapshot = null; }, '停止與平倉進行中，損益待確認'],
  ['return', () => { state.items = [item({ stage: 'sweeping' })]; state.snapshot = null; }, '返還尚未確認入帳，損益待確認'],
  ['stopped', () => { state.items = [item({ stage: 'stopped', status: 'stopped' })]; state.snapshot = null; }, '已停止，此處未確認最終損益'],
];
it.each(unknownCases)('an unknown PnL (%s) is one 待確認 pill on the card, its reason in the detail', async (_name, arrange, reason) => {
  arrange();
  await render();
  expect(card().querySelector('[data-testid="live-copy-unconfirmed"]')!.textContent).toBe('待確認');
  expect(card().textContent).toContain('—');
  for (const sentence of unknownCases.map(([, , r]) => r)) expect(card().textContent).not.toContain(sentence);
  await openCard();
  const detail = sheet().querySelector('[data-testid="live-copy-unknown-reason"]')!;
  expect(detail.textContent).toContain('待確認');
  expect(detail.textContent).toContain(reason);
});
it('a known PnL has no 待確認 pill on the card or in the detail', async () => {
  state.snapshot = observed;
  state.flows = [{ id: 'funding:1', kind: 'copy_funding', mode: 'testnet', amount: 50, strategyId: liveAccount.strategyId, status: 'credited', counterparty: liveAccount.address, fee: null, time: '2026-10-08T00:00:00Z' }];
  await render(); await openCard();
  expect(card().textContent).toContain('-$1.00');
  expect(document.querySelector('[data-testid="live-copy-unconfirmed"]')).toBeNull();
  expect(document.querySelector('[data-testid="live-copy-unknown-reason"]')).toBeNull();
});
it('keeps the operational times off the card and shows them in the detail', async () => {
  state.snapshot = observed;
  state.items = [item({ lastRefusal: { reason: 'live_source_price_deviation', at: '2026-10-08T03:00:00Z' }, executionSummary: { pending: 2, confirming: 1, oldestPendingAt: '2026-10-08T01:00:00Z',
    lastCompletedAt: '2026-10-08T01:30:00Z', sourceThrough: '2026-10-08T02:00:00Z', observedAt: '2026-10-08T02:00:05Z' } })];
  await render();
  expect(card().textContent).toContain('策略已啟用');
  for (const line of ['待處理 2', '待確認 1', '最早待處理', '最近核對完成', '領單紀錄已讀取至', '執行狀態更新', '最新帳戶觀察', '最近未執行紀錄']) expect(card().textContent).not.toContain(line);
  expect(card().querySelector('time')).toBeNull();
  await openCard();
  for (const line of ['待處理 2', '待確認 1', '最早待處理', '最近核對完成', '領單紀錄已讀取至', '執行狀態更新', '最新帳戶觀察', '最近未執行紀錄']) expect(sheet().textContent).toContain(line);
  for (const at of ['2026-10-08T01:00:00Z', '2026-10-08T01:30:00Z', '2026-10-08T02:00:00Z', '2026-10-08T02:00:05Z', '2026-10-08T01:00:00.000Z', '2026-10-08T03:00:00Z']) expect(sheet().querySelector(`time[datetime="${at}"]`), at).not.toBeNull();
});
it('separates enabled strategy from pending execution and verified completion', async () => {
  state.items = [item({ executionSummary: { pending: 2, confirming: 1, oldestPendingAt: '2026-10-08T01:00:00Z',
    lastCompletedAt: null, sourceThrough: '2026-10-08T02:00:00Z', observedAt: '2026-10-08T02:00:05Z' } })];
  await render(); await openCard();
  expect(sheet().textContent).toContain('策略已啟用');
  expect(sheet().textContent).toContain('待處理 2'); expect(sheet().textContent).toContain('待確認 1');
  expect(sheet().textContent).toContain('最早待處理');
  expect(sheet().textContent).not.toContain('最近核對完成');
  state.items = [item({ executionSummary: { pending: 0, confirming: 0, oldestPendingAt: null,
    lastCompletedAt: '2026-10-08T02:00:00Z', sourceThrough: null, observedAt: '2026-10-08T02:00:05Z' } })];
  await render(); expect(sheet().textContent).toContain('最近核對完成');
  expect(sheet().textContent).not.toContain('最早待處理');
});
it('does not invent healthy execution from a legacy API or unavailable observation', async () => {
  await render(); await openCard();
  for (const executionSummary of [undefined, null]) {
    state.items = [item({ executionSummary })]; await render();
    expect(sheet().textContent).toContain('執行狀態尚未確認');
    expect(sheet().textContent).not.toContain('待處理 0');
    expect(card().textContent).not.toContain('執行狀態尚未確認');
  }
});
it('names wallet roles and only identifies the controlled leader on explicit testnet', async () => {
  state.items = [item({ leaderAddress: '0xb56719305c461afd0de51b9e5b7146fe045553e1' })];
  await render(); await openCard();
  const details = document.querySelector('[data-testid="live-copy-sheet"] details')!;
  expect(details.textContent).toContain('跟單執行錢包'); expect(details.textContent).toContain('你的主錢包'); expect(details.textContent).toContain('測試網領單錢包');
  await act(async () => root.unmount()); root = createRoot(container);
  state.items = [item({ leaderAddress: '0xb56719305c461afd0de51b9e5b7146fe045553e1', sourceNetwork: 'mainnet' })];
  await render(); await openCard();
  expect(document.querySelector('[data-testid="live-copy-sheet"] details')!.textContent).not.toContain('測試網領單錢包');
});
it('recovers only the original setup from a progress deep link, without any action', async () => {
  state.items = []; state.search = `setupId=${id}`;
  await render();
  const resume = [...container.querySelectorAll('button')].find(button => button.textContent === '返回此設定進度');
  expect(resume).toBeDefined();
  await act(async () => resume!.click());
  expect(state.setupReads).toContain(id);
  expect(idle.mutate).not.toHaveBeenCalled(); expect(idle.mutateAsync).not.toHaveBeenCalled();
});
it('explains the real-copy minimum-order reduction exception in the actual detail', async () => {
  await render(); await openCard();
  expect(document.querySelector('[data-testid="live-copy-sheet"]')!.textContent).toContain('減倉金額低於最小下單金額時，可能放大減倉或改為全平倉');
});
it('a stale observation is 待確認 on the card, its time in the detail, and offers no stale amount', async () => {
  state.snapshot = { ...observed, freshness: 'stale' };
  state.flows = [{ id: 'funding:1', kind: 'copy_funding', mode: 'testnet', amount: 50, strategyId: liveAccount.strategyId, status: 'credited', counterparty: liveAccount.address, fee: null, time: '2026-10-08T00:00:00Z' }];
  await render();
  expect(card().querySelector('[data-testid="live-copy-unconfirmed"]')!.textContent).toBe('待確認');
  expect(card().textContent).not.toContain('-$1.00');
  await openCard();
  expect(sheet().querySelector('[data-testid="live-copy-unknown-reason"]')!.textContent).toContain('帳戶觀察已過時，損益待確認');
  expect(sheet().querySelector('time[datetime="2026-10-08T01:00:00.000Z"]')).not.toBeNull();
  // 全部 never fills in the stale withdrawable.
  expect(sheet().textContent).not.toContain('最多可提款');
  expect([...sheet().querySelectorAll('button')].some(button => button.textContent === '全部')).toBe(false);
  state.snapshot = { ...observed, freshness: 'fresh' };
  await render();
  expect(card().textContent).toContain('-$1.00');
  expect(sheet().textContent).toContain('最多可提款');
  expect(document.querySelector('[data-testid="live-copy-unknown-reason"]')).toBeNull();
});
it('separates a proven funding fee without subtracting it from PnL again', async () => {
  state.snapshot = { status: 'observed', metrics: { perpEquity: '49', withdrawable: '49' }, positions: [] };
  state.flows = [{ id: 'funding:1', kind: 'copy_funding', mode: 'testnet', amount: 50, strategyId: liveAccount.strategyId, status: 'credited', counterparty: liveAccount.address, fee: 1, time: '2026-10-08T00:00:00Z' }];
  await render(); await openCard();
  expect(card().textContent).toContain('-$1.00');
  expect(card().textContent).not.toContain('-$2.00');
  expect(document.querySelector('[data-testid="live-copy-sheet"]')!.textContent).toContain('已確認入金轉帳費');
  expect(document.querySelector('[data-testid="live-copy-sheet"]')!.textContent).toContain('此費用已包含在總損益中');
  state.flows = [{ ...(state.flows[0] as object), fee: null }];
  await render();
  expect(document.querySelector('[data-testid="live-copy-sheet"]')!.textContent).not.toContain('已確認入金轉帳費');
});
