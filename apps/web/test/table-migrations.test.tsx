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
import { actionsFeed, profileFor, traderStats } from '@/fixtures/data';
import { AdminJobs } from '@/components/admin/jobs';
import { AdminAudit } from '@/components/admin/audit';
import { api } from '@/lib/api';
import { PositionsTab } from '@/components/trader/trader-tabs';
import { settleQueries } from './query-settle';

vi.mock('next/navigation', () => ({ useRouter: () => ({refresh() {}, push() {}}), usePathname: () => '/explore', useSearchParams: () => new URLSearchParams('view=list') }));
vi.mock('@/lib/auth', () => ({ usePermission: () => true, hasPermission: () => true, useMe: () => ({data: {permissions: []}}), useAuth: () => ({status: 'signedIn', mode: 'fixture', identity: 'demo', wallet: null}) }));
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
it('marks every sortable explore and cohort column and uses an arrow for the active one', async () => {
  await render(<BoardsView />);
  expect(el.querySelectorAll('th[aria-sort="none"]').length).toBeGreaterThan(0);
  const cohort = fixtureCohort('profit');
  await render(<WalletsTable rows={cohort.wallets} />);
  const active = el.querySelector('th[aria-sort="descending"]')!;
  expect(active.querySelector('svg')).not.toBeNull();
  expect(el.querySelectorAll('th[aria-sort="none"]')).toHaveLength(8);
});
it('shows the position sort arrow and flips the direction without changing header weight', async () => {
  const sample = traderStats.map(row => profileFor(row.address, false)).find(profile => profile.positions.length > 0)!;
  const profile = JSON.parse(JSON.stringify(sample));
  await render(<PositionsTab profile={profile} marks={{}} />);
  const active = el.querySelector('th[aria-sort="descending"]')!;
  expect(active).not.toBeNull();
  expect(active.querySelector('svg')).not.toBeNull();
  expect(active.querySelector('button')?.className).not.toMatch(/font-(semibold|bold|extrabold)/);
  await act(async () => active.querySelector<HTMLButtonElement>('button')!.click());
  expect(active.getAttribute('aria-sort')).toBe('ascending');
});

it('pages the explore board through the shared ten-row pager', async () => {
  await render(<BoardsView />);
  expect(el.querySelectorAll('tbody > tr')).toHaveLength(10);
  const pager = el.querySelector('[data-pager]')!;
  expect(pager).not.toBeNull();
  await act(async () => pager.querySelectorAll<HTMLButtonElement>('button')[1].click());
  expect(pager.textContent).toContain('Page 2');
  expect(el.querySelectorAll('tbody > tr')).toHaveLength(10);
});
it('pages cohort wallets and resets to page one when sorting changes', async () => {
  const base = fixtureCohort('whale').wallets;
  const rows = Array.from({length:23}, (_,i)=>({...base[i%base.length], address:`0x${i.toString(16).padStart(40,'0')}`}));
  await render(<WalletsTable rows={rows} />);
  expect(el.querySelectorAll('tbody > tr')).toHaveLength(10);
  const pager=el.querySelector('[data-pager]')!;
  await act(async ()=>pager.querySelectorAll<HTMLButtonElement>('button')[1].click());
  expect(pager.textContent).toContain('Page 2');
  await act(async ()=>el.querySelector<HTMLButtonElement>('th[aria-sort=descending] button')!.click());
  expect(pager.textContent).toContain('Page 1');
});

it.each([['jobs', AdminJobs], ['audit', AdminAudit]] as const)('requests ten %s records and uses the shared pager', async (name, Component) => {
  const read = vi.spyOn(api, 'get');
  await render(<Component />);
  expect(read.mock.calls.some(([path])=>path.startsWith(`/admin/${name}?`) && new URLSearchParams(path.split('?')[1]).get('limit') === '10')).toBe(true);
  // Fixture audit/jobs may fit a page: the pager is hidden when no cursor remains.
  expect(el.textContent).not.toContain('settingsOps.page');
  read.mockRestore();
});

it('pages saved alerts and their live feed through the same ten-row pager', async () => {
  const originalGet=api.get;
  const {fixtureRequest}=await import('@/fixtures/handler');
  const starting=await fixtureRequest('GET','/me/favorites',undefined,'fixture-token') as import('@/lib/contracts').Favorite[];
  const favorites=Array.from({length:23},(_,i)=>({...starting[0],address:traderStats[i].address}));
  const feed=Array.from({length:23},(_,i)=>({...actionsFeed()[0],id:String(i+1)}));
  const read=vi.spyOn(api,'get').mockImplementation(async (path,signal)=>path==='/me/favorites'?favorites:path.startsWith('/actions?')?feed:originalGet(path,signal));
  try {
    await render(<FavoritesView />);
    await act(async ()=>el.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click()); await settleQueries(client);
    expect(el.querySelectorAll('[data-slot=data-list] > li')).toHaveLength(10);
    expect(el.querySelector('[data-pager]')).not.toBeNull();
    await act(async ()=>el.querySelectorAll<HTMLButtonElement>('[role=tab]')[2].click()); await settleQueries(client);
    expect(el.querySelectorAll('[data-slot=data-list] > li')).toHaveLength(10);
    const pager=el.querySelector('[data-pager]')!;
    await act(async ()=>pager.querySelectorAll<HTMLButtonElement>('button')[1].click());
    expect(pager.textContent).toContain('Page 2');
  } finally {read.mockRestore();}
});
