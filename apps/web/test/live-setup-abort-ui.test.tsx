// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveSetupAbortDialog } from '@/components/copy/live-copy-setup-abort';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveSettings } from './copy-live-fixtures';
const state = vi.hoisted(() => ({ progress: null as unknown, available: true, request: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/copy-live-setup-abort', () => ({ useLiveSetupAbort: () => ({ ...state, requesting: false, loading: false, error: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/zh-TW/portfolio', useSearchParams: () => new URLSearchParams() }));
const setup = { id: '11111111-1111-4111-8111-111111111111', kind: 'start' as const, strategyId: 1, accountId: 'account', leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'testnet' as const,
  budgetUsd: '50', settings: liveSettings, stage: 'funded' as const, issue: null, consent: null, funding: null, mandateId: null, setupDeadline: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' };
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.progress = null; state.available = true; state.request.mockReset(); state.refresh.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs['zh-TW']}><LiveSetupAbortDialog setup={setup} open onOpenChange={() => {}} /></I18nProvider>)); }
it('does not request an abort simply by opening saved progress', async () => { await render(); expect(state.request).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('已提交的操作會先核對'); const action = [...document.querySelectorAll('button')].find(b => b.textContent === '中止設定並返還資金')!; await act(async () => action.click()); expect(state.request).toHaveBeenCalledOnce(); });
it('keeps accepted returns pending and never calls them completed', async () => { state.progress = { state: 'refunding', createdAt: setup.createdAt, updatedAt: setup.updatedAt, deposit: null, refund: { status: 'accepted', amount: '49', creditedAmount: null }, stop: null, issue: null }; await render(); expect(document.body.textContent).toContain('尚未確認入帳'); expect(document.body.textContent).not.toContain('設定已安全中止'); expect(state.request).not.toHaveBeenCalled(); });
it('shows confirmed return amounts separately from setup fees', async () => { state.progress = { state: 'completed', createdAt: setup.createdAt, updatedAt: setup.updatedAt, deposit: null, refund: { status: 'credited', amount: '49', creditedAmount: '48.99' }, stop: null, issue: null }; await render(); expect(document.body.textContent).toContain('設定已安全中止'); expect(document.body.textContent).toContain('48.99 USDC'); expect(document.body.textContent).toContain('啟用轉帳費不包含'); });
it('does not offer an effective financial action without a deployment capability', async () => { state.available = false; await render(); expect(document.body.textContent).toContain('安全中止暫未開放'); expect(document.body.textContent).not.toContain('中止設定並返還資金'); expect(state.request).not.toHaveBeenCalled(); });
