// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CopyFollowerActivity } from '@/components/copy/copy-follower-activity';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { LOCALES, type Locale } from '@/i18n/config';
import { activityAccount as account, activityPage, otherActivityAccount as other } from './copy-follower-activity-fixtures';
import { flush as flushFor, settleQueries } from './query-settle';
const state = vi.hoisted(() => ({ get: vi.fn(), status: 'signedIn', mode: 'privy', identity: 'owner', session: '1' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ ...state, wallet: null }) }));
vi.mock('@/lib/api', () => ({ api: { get: state.get }, sessionKey: () => state.session }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { status: 'signedIn', mode: 'privy', identity: 'owner', session: '1' }); state.get.mockReset().mockResolvedValue(activityPage()); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
// Waits for the activity reads to answer; flush() is a plain wait for the tests
// that hold a page read open.
const settle = () => settleQueries(client, { ms: 20 });
const flush = () => flushFor(20);
async function render(a: typeof account | null = account, locale: Locale = 'en', wait: () => Promise<void> = settle) { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><CopyFollowerActivity account={a}/></I18nProvider></QueryClientProvider>)); await wait(); }
async function click(label: string) { await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === label)!.click()); await settle(); }
it('shows booked signed amounts, exact fill details and financial caveats without claiming equity or return', async () => {
  await render(); expect(container.textContent).toContain('+2.000000000000000001 USDC'); expect(container.textContent).toContain('+0.000000000000000001 USDC'); expect(container.textContent).toContain('-0.37 USDC');
  expect(container.textContent).toContain('separate from virtual paper activity'); expect(container.textContent).toContain('does not equal account equity'); expect(container.textContent).toContain('excludes deposits and withdrawals'); expect(container.textContent).toContain('Historical completeness is unproven');
  expect(container.textContent).toContain('Scan progress unknown'); expect(container.textContent).toContain('Unresolved scan windows: unknown');
  expect(container.querySelectorAll('details')).toHaveLength(2); expect(container.querySelector('details')?.open).toBe(false); expect(container.textContent).toContain('Filled quantity'); expect(container.textContent).toContain('0.01 BTC'); expect(container.textContent).toContain('Exchange order ID');
});
it('uses before-only history and refreshes the recent page without merging stale receipts', async () => {
  await render(); const older = activityPage(); older.items = [older.items[1]]; older.hasMore = false; older.previousCursor = 'older_cursor'; state.get.mockResolvedValue(older);
  expect(container.querySelector('[data-pager]')).not.toBeNull(); await click('Next'); expect(state.get.mock.lastCall?.[0]).toContain('before=opaque_cursor'); expect(container.textContent).not.toContain('+2.000000000000000001 USDC');
  state.get.mockResolvedValue(activityPage()); await click('Previous'); expect(state.get.mock.lastCall?.[0]).not.toContain('before='); expect(container.textContent).toContain('+2.000000000000000001 USDC');
});
it('discards old-account late data and never shows the previous account while a new one loads', async () => {
  let finish!: (v: unknown) => void; state.get.mockImplementation((path: string) => path.includes('/account/') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(activityPage(other)));
  await render(account, 'en', flush); await render(other, 'en', flush); await act(async () => finish(activityPage())); await settle(); expect(container.textContent).toContain(other.address!); expect(container.textContent).not.toContain(account.address!);
});
it.each(['identity', 'session'] as const)('drops the old pending page after %s changes', async field => {
  let finish!: (v: unknown) => void; state.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(() => new Promise(() => {}));
  await render(account, 'en', flush); state[field] = 'changed'; await render(account, 'en', flush); await act(async () => finish(activityPage())); await flush(); expect(container.textContent).not.toContain('+2.000000000000000001 USDC');
});
it('treats an empty booked page as unknown history rather than no exchange activity', async () => {
  const empty = activityPage(); empty.items = []; empty.previousCursor = null; empty.hasMore = false; state.get.mockResolvedValue(empty); await render();
  expect(container.textContent).toContain('This does not prove no exchange activity'); expect(container.textContent).not.toContain('0 USDC');
});
it('hides prior financial rows after a failed read and supports a safe manual retry', async () => {
  await render(); state.get.mockRejectedValue(new Error('Bearer private-token')); await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(container.textContent).toContain('Activity unavailable'); expect(container.textContent).not.toContain('private-token'); expect(container.textContent).not.toContain('+2.000000000000000001 USDC');
  state.get.mockResolvedValue(activityPage()); await click('Retry'); expect(container.textContent).toContain('+2.000000000000000001 USDC');
});
it.each([{ status: 'signedOut' }, { mode: 'fixture' }])('hides actual activity for %j', async change => { Object.assign(state, change); await render(); expect(container.querySelector('section')).toBeNull(); expect(state.get).not.toHaveBeenCalled(); });
it.each(LOCALES)('renders localized activity and uncertainty in %s', async locale => { await render(account, locale); expect(container.textContent).not.toContain('copyFollowerActivity.'); expect(container.textContent).not.toContain('copyFollowerStatement.'); expect(container.querySelector('section')?.getAttribute('aria-label')).toBeTruthy(); });
function adjustedActivity() {
 const page=activityPage(),fill=page.items[0];
 if(fill.kind!=='fill')throw Error('expected fill fixture');
 fill.size='0.004';fill.adjustment={requestedFraction:'0.25',requestedSize:'0.03',plannedSize:'0.12',reason:'minimum_reduce_full_close',admittedAt:'2026-10-02T23:59:00Z'};
 return page;
}
it('explains the verified original partial request and planned close without claiming this receipt filled the whole plan',async()=>{
 state.get.mockResolvedValue(adjustedActivity());await render();
 const detail=container.querySelector('details')!;
 expect(detail.textContent).toContain('exchange minimum');
 expect(detail.textContent).toContain('25%');
 const values=new Map([...detail.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling?.textContent]));
 expect(values.get('Filled quantity')).toBe('0.004 BTC');
 expect(values.get('Original requested quantity (includes previous remainder and rounding)')).toBe('0.03 BTC');
 expect(values.get('Planned full-close quantity')).toBe('0.12 BTC');
 expect(detail.textContent).toContain("This receipt's filled quantity is shown separately.");
 expect(detail.querySelector('time[datetime="2026-10-02T23:59:00Z"]')).not.toBeNull();
});
it.each(LOCALES)('renders the original adjustment locally in %s without adding it to unproven history',async locale=>{
 state.get.mockResolvedValue(adjustedActivity());await render(account,locale);
 expect(container.textContent).toContain('25%');expect(container.textContent).toContain('0.03 BTC');expect(container.textContent).toContain('0.12 BTC');
 expect(container.textContent).not.toContain('copyFollowerActivity.');
 state.get.mockResolvedValue(activityPage());await act(async()=>{await client.invalidateQueries();});await settle();
 expect(container.textContent).not.toContain('25%');expect(container.textContent).not.toContain('0.12 BTC');
});
it.each([null, undefined])('keeps %s original history unexplained instead of inferring a close from receipt size',async adjustment=>{
 const page=adjustedActivity(),fill=page.items[0];if(fill.kind!=='fill')throw Error('expected fill');fill.adjustment=adjustment;
 state.get.mockResolvedValue(page);await render();
 expect(container.textContent).toContain('0.004 BTC');expect(container.textContent).not.toContain('exchange minimum');expect(container.textContent).not.toContain('Planned full-close quantity');
});
