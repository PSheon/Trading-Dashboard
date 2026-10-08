// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { LiveCopyProgress } from '@/components/copy/live-copy-setup-dialogs';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveSettings } from './copy-live-fixtures';

const state = vi.hoisted(() => ({ setup: null as LiveCopySetup | null, cancel: vi.fn() }));
vi.mock('@/lib/copy-live-setup', async () => ({
  ...(await vi.importActual<typeof import('@/lib/copy-live-setup')>('@/lib/copy-live-setup')),
  useLiveCopySetup: () => ({ data: state.setup, retrying: false, failure: null }),
  useLiveCopySetupActions: () => ({ cancel: { mutate: state.cancel, isPending: false } }),
  useLiveCopyDeployment: () => ({ network: 'testnet', available: true }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/zh-TW/portfolio', useSearchParams: () => new URLSearchParams() }));
let root: Root, container: HTMLDivElement;
const id = '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c';
const created = '2026-10-08T00:00:00Z', updated = '2026-10-08T00:04:00Z';
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T00:05:00Z')); state.cancel.mockReset();
  state.setup = { id, kind: 'start', strategyId: 7, accountId: 'acct', leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'testnet', budgetUsd: '50', settings: liveSettings,
    stage: 'funding_submitted', issue: 'awaiting_credit', consent: null, funding: null, mandateId: null, setupDeadline: null, createdAt: created, updatedAt: updated };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function render() { await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}><LiveCopyProgress setupId={id} open onOpenChange={() => {}} /></I18nProvider>)); }
const creditRow = () => document.querySelector('[data-testid="live-copy-stages"] li[data-state="current"]');
it('calls the current credit step 等待入帳 and only completed credit 已入帳', async () => {
  await render(); expect(creditRow()?.textContent).toBe('等待入帳');
  state.setup!.stage = 'funded'; state.setup!.issue = null;
  await render();
  expect([...document.querySelectorAll('[data-testid="live-copy-stages"] li[data-state="done"]')].map(row => row.textContent)).toContain('已入帳');
});
it('shows elapsed setup time and actual latest state update, without calling it last progress', async () => {
  await render();
  expect(document.body.textContent).toContain('設定已經過 5 分鐘');
  expect(document.body.textContent).toContain('最新狀態更新');
  expect(document.querySelector('time[datetime="2026-10-08T00:04:00Z"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('最後進展');
});
it('provides a link to the original setup, with no new deposit or cancellation action', async () => {
  await render();
  const link = document.querySelector('a[href*="setupId="]');
  expect(link?.getAttribute('href')).toContain(`setupId=${id}`);
  expect(link?.getAttribute('href')).toContain('view=real');
  expect(link?.textContent).toContain('返回此設定進度');
  expect(state.cancel).not.toHaveBeenCalled();
});
it('shows credited funding and its known fee separately, and omits unknown fees', async () => {
  state.setup!.stage = 'funded'; state.setup!.issue = null;
  state.setup!.funding = { status: 'credited', amount: '50', creditedAmount: '49', fee: '1', updatedAt: updated } as LiveCopySetup['funding'];
  await render();
  expect(document.body.textContent).toContain('啟用轉帳費');
  expect(document.body.textContent).toContain('1 USDC');
  expect(document.body.textContent).toContain('實際入帳');
  expect(document.body.textContent).toContain('49 USDC');
  state.setup!.funding!.fee = null;
  await render(); expect(document.body.textContent).not.toContain('啟用轉帳費');
});
