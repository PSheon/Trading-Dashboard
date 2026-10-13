// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { useLiveCopyPortfolio } from '@/lib/copy-live-portfolio';
import { useLiveCopySetup, useLiveCopySetupActions } from '@/lib/copy-live-setup';

// After 取消並退款 succeeds, the live-copy sheet (the portfolio item) and the
// setup's own poll show the cancel at once, and both are read again; before,
// they kept 完成設定 / 待確認 until their next poll.
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), identity: 'cancel-owner@email' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: state.identity, userId: state.identity, wallet: { address: `0x${'11'.repeat(20)}` } }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/portfolio', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/api', async () => ({ ApiError: (await vi.importActual<typeof import('@/lib/api')>('@/lib/api')).ApiError, api: { get: state.get, post: state.post }, sessionKey: () => '1' }));

const id = '0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c', now = new Date().toISOString();
const settings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const setup = (abortRequested: boolean): LiveCopySetup => ({ id, kind: 'start', strategyId: 7, accountId: 'acct', leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'mainnet',
  budgetUsd: '150', settings, stage: 'funding_submitted', issue: 'awaiting_credit', consent: null, funding: null, mandateId: null, setupDeadline: null, abortRequested, createdAt: now, updatedAt: now });
const portfolio = (abortRequested: boolean) => ({ network: 'testnet', automaticExecution: true, items: [{ strategyId: 7, leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'mainnet',
  network: 'testnet', status: 'paused', stage: 'setup', createdAt: now, budgetUsd: '150', accountId: 'acct', accountAddress: `0x${'22'.repeat(20)}`,
  mandate: null, stop: null, pendingTransfer: null, lastRefusal: null, setup: { id, kind: 'start', stage: 'funding_submitted', issue: 'awaiting_credit', abortRequested, fundingStatus: 'accepted', consent: null } }] });

let root: Root, container: HTMLDivElement, client: QueryClient;
const probe: { actions: ReturnType<typeof useLiveCopySetupActions> | null; portfolio: ReturnType<typeof useLiveCopyPortfolio> | null; setup: ReturnType<typeof useLiveCopySetup> | null } =
  { actions: null, portfolio: null, setup: null };
function Probe() {
  const actions = useLiveCopySetupActions(), items = useLiveCopyPortfolio(), progress = useLiveCopySetup(id);
  useLayoutEffect(() => { probe.actions = actions; probe.portfolio = items; probe.setup = progress; });
  return null;
}
/** The reads after the cancel answer only once released: what shows until then is the cancel's own answer. */
let release: () => void = () => undefined;
const reads = (path: string) => state.get.mock.calls.filter(([url]) => url === path).length;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  let cancelled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  state.post.mockImplementation(async (url: string) => { expect(url).toBe(`/me/copy/live/setups/${id}/cancel`); cancelled = true; return setup(true); });
  state.get.mockImplementation(async (url: string) => {
    if (cancelled) await gate;
    if (url === '/me/copy/live/portfolio') return portfolio(cancelled);
    if (url === `/me/copy/live/setups/${id}`) return setup(cancelled);
    throw new Error(`unexpected read ${url}`);
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  await vi.waitFor(() => { expect(probe.portfolio!.data?.items).toHaveLength(1); expect(probe.setup!.data).toBeDefined(); });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

it('on cancel success the portfolio item and the setup show the cancel at once, and both are read again', async () => {
  expect(probe.portfolio!.data!.items[0]!.setup).toMatchObject({ abortRequested: false });
  const portfolioReads = reads('/me/copy/live/portfolio'), setupReads = reads(`/me/copy/live/setups/${id}`);
  await act(async () => { await probe.actions!.cancel.mutateAsync(id); });
  // Before any read answers: the cancel's own answer.
  await vi.waitFor(() => {
    expect(probe.portfolio!.data!.items[0]!.setup).toMatchObject({ id, abortRequested: true, stage: 'funding_submitted' });
    expect(probe.setup!.data).toMatchObject({ id, abortRequested: true });
  });
  // Both are read again (invalidated), not left to their next poll.
  expect(reads('/me/copy/live/portfolio')).toBeGreaterThan(portfolioReads);
  expect(reads(`/me/copy/live/setups/${id}`)).toBeGreaterThan(setupReads);
  await act(async () => { release(); });
  await vi.waitFor(() => expect(probe.portfolio!.isFetching).toBe(false));
  expect(probe.portfolio!.data!.items[0]!.setup).toMatchObject({ abortRequested: true });
});
