// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { ToastProvider } from '@/components/ui/toast';
import { ActionsTable } from '@/components/actions/actions-table';
import { FavoritesView } from '@/components/favorites/favorites-view';
import { BoardsView } from '@/components/explore/boards-view';
import { MarketsTable, WalletsTable } from '@/components/insights/cohort-tables';
import { fixtureCohort } from '@/fixtures/discovery';
import { actionsFeed } from '@/fixtures/data';
import { settleQueries } from './query-settle';

vi.mock('next/navigation', () => ({ useRouter: () => ({refresh() {}, push() {}}), usePathname: () => '/explore', useSearchParams: () => new URLSearchParams('view=list') }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({status: 'signedIn', mode: 'fixture', identity: 'demo', wallet: null}) }));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: {...actual.api, get: async (path: string) => {
    const {fixtureRequest} = await import('@/fixtures/handler');
    return fixtureRequest('GET', path, undefined, 'fixture-token');
  }} };
});
// Network streaming is independent of the rendered table and sorting.
vi.mock('@/lib/use-action-stream', () => ({ useActionStream: () => ({status: 'connecting', highlight: new Set()}) }));
let root: Root, el: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  client = new QueryClient({defaultOptions: {queries: {retry: false}}});
});
afterEach(async () => {await act(async () => root.unmount()); client.clear(); el.remove();});
async function render(node: ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><ToastProvider>{node}</ToastProvider></I18nProvider></QueryClientProvider>));
  await settleQueries(client);
}
it('expands action fills in a shared dense table and collapses the detail', async () => {
  await render(<ActionsTable rows={JSON.parse(JSON.stringify(actionsFeed().slice(0, 1)))} />);
  const toggle = el.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => toggle.click()); await settleQueries(client);
  const tables = el.querySelectorAll('table');
  expect(tables).toHaveLength(2);
  expect(tables[1].getAttribute('data-slot')).toBe('table');
  expect(tables[1].parentElement?.classList.contains('table-dense')).toBe(true);
  expect(tables[1].closest('.row-expansion')).not.toBeNull();
  expect(tables[1].querySelectorAll('th')).toHaveLength(6);
  await act(async () => toggle.click());
  expect(el.querySelectorAll('table')).toHaveLength(1);
});
it('sorts the watchlist through accessible shared heads and restores saved order', async () => {
  await render(<FavoritesView />);
  const table = el.querySelector('table')!;
  expect(table.getAttribute('data-slot')).toBe('table');
  const heads = [...table.querySelectorAll('th[aria-sort]')];
  expect(heads).toHaveLength(8);
  expect(heads.every(h => h.getAttribute('aria-sort') === 'none')).toBe(true);
  const rows = () => [...table.querySelectorAll('tbody tr')].map(row => row.textContent);
  const saved = rows();
  const sort = heads[2].querySelector<HTMLButtonElement>('button')!;
  await act(async () => sort.click());
  expect(heads[2].getAttribute('aria-sort')).toBe('descending');
  expect(rows()).not.toEqual(saved);
  await act(async () => sort.click());
  expect(heads[2].getAttribute('aria-sort')).toBe('none');
  expect(rows()).toEqual(saved);
});
it('renders the explore list in the shared table', async () => {
  await render(<BoardsView />);
  expect(el.querySelector('table')?.getAttribute('data-slot')).toBe('table');
  expect(el.querySelectorAll('tbody [data-slot="table-row"]').length).toBeGreaterThan(0);
});
it('aligns cohort wallets and markets with shared table cells while keeping filtering', async () => {
  const cohort = fixtureCohort('profit');
  await render(<><WalletsTable rows={cohort.wallets} /><MarketsTable rows={cohort.markets} filter="crypto" /></>);
  const tables = el.querySelectorAll('table');
  expect(tables).toHaveLength(2);
  expect([...tables].every(table => table.getAttribute('data-slot') === 'table')).toBe(true);
  expect(tables[1].textContent).toContain('BTC');
  expect(tables[1].textContent).not.toContain('SP500');
});
