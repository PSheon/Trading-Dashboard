// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminCopyLive } from '@/components/admin/copy/live';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import type { Locale } from '@/i18n/config';
import { settleQueries } from './query-settle';

const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), permissions: ['admin.access', 'copy.read'] as string[], network: 'testnet' as string | null }));
vi.mock('@/lib/api', () => ({ api: { get: state.get, post: state.post } }));
vi.mock('@/lib/auth', () => ({ usePermission: (p: string) => state.permissions.includes(p), useMe: () => ({ data: { permissions: state.permissions } }) }));
vi.mock('@/lib/copy-live-setup', () => ({ useLiveCopyDeployment: () => (state.network ? { network: state.network } : null) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/admin/copy/live' }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const at = '2026-10-04T10:00:00.000Z', addr = (b: string) => `0x${b.repeat(20)}`;
const account = { accountId: 'account', userId: 7, userEmail: 'alice@example.com', strategyId: 9, leaderAddress: addr('44'), sourceNetwork: 'mainnet', accountAddress: addr('55'),
  accountState: 'ready', strategyStatus: 'active', agent: { setupId: 'setup', state: 'active', agentAddress: addr('33'), expiresAt: at },
  grant: { id: 'grant-1', version: 4, scopes: ['copy:trade', 'copy:reduce'], expiresAt: at, revokedAt: null, revokeRequestedAt: null }, mandate: { id: 'mandate', state: 'active', revision: 2 }, stop: null, createdAt: at };
const order = (key: string, state: string, purpose: string) => ({ key, userId: 7, strategyId: 9, accountAddress: addr('55'), coin: 'BTC', side: 'B', size: '0.1', limitPrice: '101', reduceOnly: purpose !== 'copy',
  state, errorCode: state === 'unknown' ? 'exchange_order_not_yet_found' : null, purpose, leg: purpose === 'copy' ? { leg: 'open', state: 'submitted', reason: null } : null, createdAt: at, updatedAt: at });
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.permissions = ['admin.access', 'copy.read'];
  state.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/copy/live/accounts') return { items: [account] };
    if (path === '/admin/copy/live/transfers') return { items: [{ id: '33333333-3333-4333-8333-333333333333', userId: 7, accountId: 'account', strategyId: 9, direction: 'to_main', status: 'accepted',
      amount: '12.5', source: addr('55'), destination: addr('11'), stopId: null, transactionHash: null, attemptedAt: at, createdAt: at, updatedAt: at }] };
    if (path.startsWith('/admin/copy/live/orders')) return { items: path.endsWith('unknown') ? [order('k1', 'unknown', 'copy')] : [order('k1', 'unknown', 'copy'), order('k2', 'resting', 'stop')] };
    if (path.startsWith('/admin/copy/live/latency')) return path.endsWith('7d')
      ? { window: '7d', count: 0, signal: { p50: null, p95: null }, sent: { p50: null, p95: null }, ack: { p50: null, p95: null }, settled: { p50: null, p95: null } }
      : { window: '24h', count: 12, signal: { p50: 820, p95: 2400 }, sent: { p50: 1300, p95: 61000 }, ack: { p50: 1450, p95: 61200 }, settled: { p50: 5000, p95: 70000 } };
    return null;
  });
  state.post.mockReset().mockResolvedValue({ id: 'grant-1', version: 4, revokedAt: null, revokeRequestedAt: at, stopId: 'stop-1' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); document.body.innerHTML = ''; });
const settle = () => settleQueries(client, { ms: 15 });
async function render(locale: Locale = 'en') {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><AdminCopyLive /></I18nProvider></QueryClientProvider>));
  await settle();
}
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label);
const text = () => document.body.textContent ?? '';

it('shows latency P50/P95 per step, wallets with grant, open orders by purpose and transfers', async () => {
  await render();
  expect(text()).toContain('Copy latency'); expect(text()).toContain('12 copied fills');
  const latency = container.querySelector('[data-testid="copy-live-latency"]')!.textContent!;
  expect(latency).toContain('Signal received'); expect(latency).toContain('820 ms'); expect(latency).toContain('61,000 ms');
  expect(text()).toContain('alice@example.com'); expect(text()).toContain('mainnet leader'); expect(text()).toContain('v4');
  expect(text()).toContain('Copy'); expect(text()).toContain('Stop close'); expect(text()).toContain('exchange_order_not_yet_found');
  expect(text()).toContain('Return to main wallet'); expect(text()).toContain('12.5 USDC');
  expect(button('Revoke grant')).toBeUndefined(); // needs execution.pause
  await act(async () => button('7 d')!.click()); await settle();
  expect(text()).toContain('No copied fills in this window.');
  await act(async () => button('Unknown outcome')!.click()); await settle();
  expect(state.get).toHaveBeenCalledWith('/admin/copy/live/orders?state=unknown', expect.anything());
  expect(text()).toContain('the exchange has not confirmed yet');
});

it('revokes a grant with a reason when the admin may pause execution', async () => {
  state.permissions.push('execution.pause');
  await render();
  await act(async () => button('Revoke grant')!.click());
  expect(text()).toContain('The copy is stopped at once: no new order can open risk.');
  expect((button('Revoke') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    const area = document.querySelector('#copy-live-revoke-reason') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'leaked agent key'); area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Revoke')!.click()); await settle();
  expect(state.post).toHaveBeenCalledWith('/admin/copy/live/grants/grant-1/revoke', { reason: 'leaked agent key' });
});

it('renders in the source catalog (zh-TW)', async () => {
  await render('zh-TW');
  expect(text()).toContain('跟單延遲'); expect(text()).toContain('執行錢包'); expect(text()).toContain('錢包轉帳'); expect(text()).toContain('測試網跟單');
});

it('shows a revoke that waits for the copy\'s stop, and offers no second revoke', async () => {
  state.permissions = ['admin.access', 'copy.read', 'execution.pause'];
  const pending = { ...account, strategyStatus: 'stopping', grant: { ...account.grant, revokeRequestedAt: at }, stop: { id: 'stop-1', state: 'closing', issue: null } };
  state.get.mockImplementation(async (path: string) => path === '/admin/copy/live/accounts' ? { items: [pending] }
    : path.startsWith('/admin/copy/live/latency') ? { window: '24h', count: 0, signal: { p50: null, p95: null }, sent: { p50: null, p95: null }, ack: { p50: null, p95: null }, settled: { p50: null, p95: null } }
    : { items: [] });
  await render();
  expect(text()).toContain("revoke requested");
  expect(text()).toContain("kept for the stop's closes, revoked when it ends");
  expect(button('Revoke grant')).toBeUndefined();
  // Revoking now, without the stop, needs the explicit confirmation.
  await act(async () => button('Revoke now')!.click());
  expect(text()).toContain('any position or resting order still on the copy account stays open');
  await act(async () => {
    const area = document.querySelector('#copy-live-revoke-reason') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'stop is stuck'); area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = () => [...document.querySelectorAll('button')].filter(b => b.textContent === 'Revoke now').at(-1) as HTMLButtonElement;
  expect(submit().disabled).toBe(true);
  await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click()); await settle();
  expect(state.post).toHaveBeenCalledWith('/admin/copy/live/grants/grant-1/revoke', { reason: 'stop is stuck', force: true });
});

it('names the actual-copies page by the deployment: 正式 on mainnet, 測試網 otherwise (Stage B9)', async () => {
  const { useCopySubTabs } = await import('@/components/admin/copy/status');
  const labels: Array<ReturnType<typeof useCopySubTabs>> = [];
  function Probe() { labels.push(useCopySubTabs()); return null; }
  for (const network of ['mainnet', 'testnet', null]) {
    state.network = network;
    await act(async () => root.render(<Probe />));
  }
  expect(labels.map((l) => l['/admin/copy/testnet'])).toEqual(['admin.sub.copyLive', 'admin.sub.copyTestnet', 'admin.sub.copyTestnet']);
  state.network = 'mainnet';
  await render('zh-TW');
  expect(container.textContent).toContain('正式跟單');
  expect(container.textContent).not.toContain('測試網跟單');
  state.network = 'testnet';
});
