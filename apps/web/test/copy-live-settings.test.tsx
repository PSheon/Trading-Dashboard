// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CopyLiveStrategySettings } from '@/components/settings/copy-live';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { LOCALES, type Locale } from '@/i18n/config';
import { liveAccount, liveIntent, liveMandate, liveNow, liveOverview, liveOwner, liveSetup, liveStrategy } from './copy-live-fixtures';
import { createLiveCopyJournal } from '@/lib/copy-live';
import type { CopyWalletGrant } from '@trading-dashboard/shared/contracts';
import { settleQueries, type SettleOptions } from './query-settle';
import { chooseOption } from './select-helper';
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), sign: vi.fn(), status: 'signedIn', mode: 'privy', identity: 'owner@email', session: '1' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ ...state, userId: 'did:privy:owner', wallet: { address: liveOwner, signTypedData: state.sign } }) }));
vi.mock('@/lib/api', () => ({ api: { get: state.get, post: state.post }, sessionKey: () => state.session }));
vi.mock('@/lib/query-policy', () => ({ defaultRetry: { retry: false } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
let root: Root, container: HTMLDivElement, client: QueryClient, overview: ReturnType<typeof liveOverview>;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { status: 'signedIn', mode: 'privy', identity: 'owner@email', session: '1' }); vi.spyOn(Date, 'now').mockReturnValue(liveNow); window.sessionStorage.clear(); state.get.mockReset(); state.post.mockReset(); state.sign.mockReset().mockResolvedValue(`0x${'aa'.repeat(65)}`); overview = liveOverview(); state.get.mockImplementation((path: string) => Promise.resolve(path === '/me/copy/live' ? overview : path === '/me/copy/agents' ? { available: true, network: 'testnet', setups: [liveSetup] } : { mandate: overview.mandates[0] ?? liveMandate, intent: liveIntent })); state.post.mockImplementation(async (path: string, body: { budgetUsd?: string }) => path.endsWith('/approve') ? { ...liveMandate, state: 'active', revision: 2 } : path.endsWith('/strategies') ? { ...liveStrategy, budgetUsd: body.budgetUsd } : { mandate: liveMandate, intent: liveIntent }); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });
// Waits for the live-copy queries and mutations to answer; settleHeld() waits for
// queries only, while a test holds the wallet prompt or the renewal POST open.
const settle = (options?: SettleOptions) => settleQueries(client, { ms: 25, ...options });
const settleHeld = () => settle({ mutations: false });
async function render(locale: Locale = 'en', grants?: CopyWalletGrant[], wait: () => Promise<void> = settle) { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><CopyLiveStrategySettings accounts={[liveAccount]} authorizations={grants}/></I18nProvider></QueryClientProvider>)); await wait(); }
async function click(label: string, wait: () => Promise<void> = settle) { const b = [...container.querySelectorAll('button')].find(b => b.textContent === label); expect(b).toBeTruthy(); await act(async () => b!.click()); await wait(); }
async function select() { await chooseOption(container.querySelector('[data-slot="select-trigger"][id$="-account"]'), liveAccount.id); await settle(); }
async function input(name: string, value: string) { await act(async () => { const el = container.querySelector(`input[name="${name}"]`)! as HTMLInputElement; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); await settle(); }
it('shows separate actual preparation and budget consent without paper equity or activation claims', async () => { await render(); expect(container.textContent).toContain('The budget is not a deposit'); expect(container.textContent).toContain('Automatic testnet execution is off on this server'); expect(state.post).not.toHaveBeenCalled(); expect(state.sign).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('0%'); });
it('creates only an explicitly entered paused draft and preserves the exact budget string', async () => { overview = { ...overview, strategies: [], mandates: [] }; await render(); await input('leader', liveStrategy.leaderAddress); await input('budget', '100.000001'); await click('Prepare paused strategy'); expect(state.post.mock.calls[0][0]).toBe('/me/copy/live/strategies'); expect(state.post.mock.calls[0][1]).toMatchObject({ budgetUsd: '100.000001', sourceNetwork: 'testnet', settings: { direction: 'same', sizingMode: 'ratio', copyStartMode: 'delta' } }); expect(state.sign).not.toHaveBeenCalled(); });
it('requires original full intent review plus an explicit checkbox before exact local consent', async () => { await render(); await select(); expect(container.querySelector('article input[type="checkbox"]')).toBeNull(); await click('Review original consent'); expect(container.textContent).toContain(liveOwner); expect(container.textContent).toContain(liveSetup.agentAddress!); expect(container.textContent).toContain('100 USDC'); const approve = [...container.querySelectorAll('button')].find(b => b.textContent === 'Sign local consent')!; expect(approve.disabled).toBe(true); await act(async () => { (container.querySelector('article input[type="checkbox"]') as HTMLInputElement).click(); }); await click('Sign local consent'); expect(state.sign).toHaveBeenCalledOnce(); expect(state.post.mock.calls[0][0]).toBe('/me/copy/live/mandates/mandate/approve'); expect(container.textContent).toContain('Automatic testnet execution is off on this server'); });
it('a lost consent response remains original read-only checking, never another signature or POST', async () => { state.post.mockRejectedValue(new Error('private-error')); await render(); await select(); await click('Review original consent'); await act(async () => { (container.querySelector('article input[type="checkbox"]') as HTMLInputElement).click(); }); await click('Sign local consent'); expect(container.textContent).toContain('Original request unconfirmed'); expect(container.textContent).not.toContain('private-error'); await click('Check original request'); expect(state.sign).toHaveBeenCalledOnce(); expect(state.post).toHaveBeenCalledOnce(); });
it('discarding the selected account during a held wallet prompt prevents approval', async () => { let finish!: (s: string) => void; state.sign.mockImplementation(() => new Promise(r => { finish = r; })); await render(); await select(); await click('Review original consent'); await act(async () => { (container.querySelector('article input[type="checkbox"]') as HTMLInputElement).click(); }); await click('Sign local consent', settleHeld); state.session = 'changed'; await render('en', undefined, settleHeld); await act(async () => finish(`0x${'aa'.repeat(65)}`)); await settle(); expect(state.post).not.toHaveBeenCalled(); expect(container.querySelector('select[name="account"]')?.getAttribute('value')).not.toBe(liveAccount.id); });
it.each([{ status: 'signedOut' }, { mode: 'fixture' }])('hides actual preparation and avoids reads under %j', async change => { Object.assign(state, change); await render(); expect(container.querySelector('section')).toBeNull(); expect(state.get).not.toHaveBeenCalled(); });
it.each(LOCALES)('renders translated actual preparation caveats and consent in %s', async locale => { await render(locale); expect(container.querySelector('section')?.getAttribute('aria-label')).toBeTruthy(); expect(container.textContent).not.toContain('copyLive.'); });
it('allows owner local revocation even after the agent is revoked, and uncertain revocation only reads the original record', async () => {
  overview = { ...overview, mandates: [{ ...liveMandate, state: 'active', revision: 2 }] };
  state.get.mockImplementation((path: string) => Promise.resolve(path === '/me/copy/live' ? overview : path === '/me/copy/agents' ? { available: true, network: 'testnet', setups: [{ ...liveSetup, state: 'revoked' }] } : { mandate: overview.mandates[0], intent: liveIntent }));
  state.post.mockRejectedValue(new Error('lost')); await render(); await select(); await click('Revoke local consent'); expect(state.post).toHaveBeenCalledOnce(); expect(container.textContent).toContain('Original request unconfirmed');
  await click('Check original request'); expect(state.post).toHaveBeenCalledOnce(); expect(state.sign).not.toHaveBeenCalled(); expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Revoke local consent')).toBe(false);
});

const renewalGrant: CopyWalletGrant = { id: 'grant', strategyId: liveStrategy.id, network: 'testnet', accountAddress: liveAccount.address!, signerAddress: liveSetup.agentAddress!, status: 'active', scopes: ['copy:trade', 'copy:reduce'], expiresAt: liveSetup.expiresAt, revokedAt: null, version: 1 };
function renewalRead(eligible = true) { return { mandate: liveMandate, intent: liveIntent, renewal: { checkedAt: new Date(liveNow + 300000).toISOString(), eligible, reason: eligible ? 'prepared_consent_expired' : null, mandateId: liveMandate.id, revision: 1, nonce: liveNow } }; }
function uncertainOriginal() { createLiveCopyJournal(`privy:owner@email:${liveOwner}`, window.sessionStorage).mark(liveMandate.id); }
it('requires server proof plus a separate renewal checkbox/button; a double click creates one new request and no signature', async () => {
  vi.mocked(Date.now).mockReturnValue(liveNow + 300000); uncertainOriginal();
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live' ? overview : path === '/me/copy/agents' ? { available: true, network: 'testnet', setups: [liveSetup] } : renewalRead());
  state.post.mockImplementation(async (_path, _body, options) => { options.beforeSend(); const m = { ...liveMandate, id: 'successor', createdAt: new Date(Date.now()).toISOString(), updatedAt: new Date(Date.now()).toISOString() }; overview = { ...overview, mandates: [liveMandate, m] }; return { mandate: m, intent: { ...liveIntent, mandateId: m.id, nonce: Date.now(), consentExpiresAt: Date.now() + 300000 } }; });
  await render('en', [renewalGrant]); await select(); expect(container.textContent).not.toContain('Prepare new consent generation');
  await click('Check original request'); const b = [...container.querySelectorAll('button')].find(b => b.textContent === 'Prepare new consent generation')!; expect(b).toBeTruthy(); expect(b.disabled).toBe(true);
  await act(async () => (container.querySelector('input[name="renewal"]') as HTMLInputElement).click());
  await act(async () => { b.click(); b.click(); }); await settle();
  expect(state.post).toHaveBeenCalledOnce(); expect(state.post.mock.calls[0][0]).toBe(`/me/copy/live/execution-wallets/${liveAccount.id}/mandates`); expect(state.sign).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem(`copy-live-recovery:v1:${encodeURIComponent(`privy:owner@email:${liveOwner}`)}`)).toContain(liveMandate.id);
  expect(container.textContent).toContain('Automatic testnet execution is off on this server');
});
it('browser consent expiry without eligible server evidence never enables renewal', async () => {
  vi.mocked(Date.now).mockReturnValue(liveNow + 300000); uncertainOriginal();
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live' ? overview : path === '/me/copy/agents' ? { available: true, network: 'testnet', setups: [liveSetup] } : renewalRead(false));
  await render('en', [renewalGrant]); await select(); await click('Check original request'); expect(container.textContent).not.toContain('Prepare new consent generation'); expect(state.post).not.toHaveBeenCalled(); expect(state.sign).not.toHaveBeenCalled();
});
it('an eligible original with an expired agent directs separate agent renewal with zero consent POST', async () => {
  vi.mocked(Date.now).mockReturnValue(liveNow + 300000);
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live' ? overview : path === '/me/copy/agents' ? { available: true, network: 'testnet', setups: [{ ...liveSetup, state: 'expired' }] } : renewalRead());
  await render('en', [renewalGrant]); await select(); await click('Review original consent'); expect(container.textContent).toContain('Renew the agent separately before preparing new consent.'); expect(container.textContent).not.toContain('Prepare new consent generation'); expect(state.post).not.toHaveBeenCalled();
});
it('saved unsupported source/adoption settings stay visible and cannot prepare consent', async () => {
  overview = { ...overview, strategies: [{ ...liveStrategy, sourceNetwork: 'mainnet', settings: { ...liveStrategy.settings, copyStartMode: 'adopt' } }], mandates: [] };
  await render('en', [renewalGrant]); await select(); expect(container.textContent).toContain('This saved source network or adoption setting is not supported'); expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Prepare local consent')).toBe(false); expect(state.post).not.toHaveBeenCalled();
});

it.each(LOCALES)('renders native explicit renewal strings without fallback keys in %s',async locale=>{
  vi.mocked(Date.now).mockReturnValue(liveNow+300000);uncertainOriginal();
  state.get.mockImplementation(async(path:string)=>path==='/me/copy/live'?overview:path==='/me/copy/agents'?{available:true,network:'testnet',setups:[liveSetup]}:renewalRead());
  await render(locale,[renewalGrant]);await select();await click(catalogs[locale].copyLive.find);
  expect(container.textContent).toContain(catalogs[locale].copyLive.renew);expect(container.textContent).toContain(catalogs[locale].copyLive.renewalAcknowledgment);expect(container.textContent).not.toContain('copyLive.');expect(state.post).not.toHaveBeenCalled();
});
it('changing owner session during held renewal preparation prevents its final HTTP and discards selected review',async()=>{
  vi.mocked(Date.now).mockReturnValue(liveNow+300000);uncertainOriginal();let finish!:()=>void;const http=vi.fn();
  state.get.mockImplementation(async(path:string)=>path==='/me/copy/live'?overview:path==='/me/copy/agents'?{available:true,network:'testnet',setups:[liveSetup]}:renewalRead());
  state.post.mockImplementation(async(_path,_body,options)=>{await new Promise<void>(r=>{finish=r;});options.beforeSend();http();return {mandate:liveMandate,intent:liveIntent};});
  await render('en',[renewalGrant]);await select();await click('Check original request');await act(async()=>(container.querySelector('input[name="renewal"]')as HTMLInputElement).click());await click('Prepare new consent generation',settleHeld);
  state.session='successor-session';await render('en',[renewalGrant],settleHeld);await act(async()=>finish());await settle();expect(http).not.toHaveBeenCalled();expect(container.querySelector('input[name="renewal"]')).toBeNull();expect(state.sign).not.toHaveBeenCalled();
});
it('lost new-generation preparation exposes its stored original key for GET-only recovery without another UUID or POST',async()=>{
  vi.mocked(Date.now).mockReturnValue(liveNow+300000);uncertainOriginal();const key=vi.spyOn(crypto,'randomUUID').mockReturnValue('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  state.get.mockImplementation(async(path:string)=>path==='/me/copy/live'?overview:path==='/me/copy/agents'?{available:true,network:'testnet',setups:[liveSetup]}:path.includes('/by-key/')?{mandate:{...liveMandate,id:'successor'},intent:{...liveIntent,mandateId:'successor',nonce:Date.now(),consentExpiresAt:Date.now()+300000}}:renewalRead());state.post.mockRejectedValue(new Error('lost'));
  await render('en',[renewalGrant]);await select();await click('Check original request');await act(async()=>(container.querySelector('input[name="renewal"]')as HTMLInputElement).click());await click('Prepare new consent generation');
  const recovery=[...container.querySelectorAll('button')].find(b=>b.textContent==='Check original request'&&b.parentElement?.querySelector('[role="status"]')?.textContent?.includes('Original request unconfirmed'))!;expect(recovery).toBeTruthy();await act(async()=>recovery.click());await settle();
  expect(state.get).toHaveBeenCalledWith('/me/copy/live/mandates/by-key/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');expect(state.post).toHaveBeenCalledOnce();expect(key).toHaveBeenCalledOnce();expect(state.sign).not.toHaveBeenCalled();
});
it('an acknowledged generation does not become expired merely because its historical signing TTL passed',async()=>{
  vi.mocked(Date.now).mockReturnValue(liveNow+300000);overview={...overview,mandates:[{...liveMandate,state:'active',revision:2}]};
  state.get.mockImplementation(async(path:string)=>path==='/me/copy/live'?overview:path==='/me/copy/agents'?{available:true,network:'testnet',setups:[liveSetup]}:{...renewalRead(false),mandate:overview.mandates[0],renewal:{...renewalRead(false).renewal,revision:2}});
  await render('en',[renewalGrant]);await select();await click('Check original request');const statuses=[...container.querySelectorAll('article [role="status"]')].map(el=>el.textContent);expect(statuses).toContain(catalogs.en.copyLive.states.active);expect(statuses).not.toContain(catalogs.en.copyLive.states.expired);expect(container.textContent).not.toContain('Prepare new consent generation');
});

it.each(['revoked', 'expired'] as const)('keeps stopping an approved %s generation available during prepared renewal', async oldState => {
  overview = { ...overview, mandates: [
    { ...liveMandate, id: 'new-prepared' },
    { ...liveMandate, id: 'old-approved', state: oldState, revision: 3, activationCursor: new Date(liveNow).toISOString() },
  ] };
  state.get.mockImplementation(async (path: string) => path === '/me/copy/live' ? overview
    : path === '/me/copy/agents' ? { available: true, network: 'testnet', setups: [liveSetup] }
    : path === '/me/copy/live/stops' ? { items: [], truncated: false }
    : { mandate: overview.mandates[0], intent: liveIntent });
  await render(); await select();
  const request = [...container.querySelectorAll('button')].find(button => button.textContent === 'Request stop')!;
  expect(request).toBeTruthy();
  expect(request.disabled).toBe(false);
  // The mandate id is internal and never shown; the stop goes to the approved generation.
  expect(request.closest('section')?.textContent).not.toContain('old-approved');
  expect(state.post).not.toHaveBeenCalled();
  expect(state.sign).not.toHaveBeenCalled();
});
