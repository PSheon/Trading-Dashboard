// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CopyLiveStop } from '@/components/copy/copy-live-stop';
import { createLiveStopJournal, type LiveStopSelection } from '@/lib/copy-live-stop';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { liveStopMessages, liveStopResumeMessages, liveStopDiscardMessages } from '@/i18n/copy-live-stop';
import { LOCALES, type Locale } from '@/i18n/config';
import { liveAccount, liveMandate, liveNow } from './copy-live-fixtures';
import { flush as flushFor, settleQueries, type SettleOptions } from './query-settle';
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), sign: vi.fn(), status: 'signedIn', mode: 'privy', identity: 'owner@email', session: '1', ownerId: 'did:privy:owner' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ ...state, userId: state.ownerId, wallet: null }) }));
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: { get: state.get, post: state.post }, sessionKey: () => state.session }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const stop = () => ({ id: '11111111-1111-4111-8111-111111111111', accountId: liveAccount.id, mandateId: liveMandate.id, strategyId: liveMandate.strategyId, network: 'testnet', accountAddress: liveMandate.accountAddress, originalMandateRevision: 2, revision: 1, state: 'requested', desiredAction: 'cancel_and_close', trackedExecutionCount: 2, trackingComplete: true, issue: null, flatVerifiedAt: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow + 1000).toISOString() });
let root: Root, container: HTMLDivElement, client: QueryClient, selection: LiveStopSelection;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { status: 'signedIn', mode: 'privy', identity: 'owner@email', session: '1', ownerId: 'did:privy:owner' });
  window.sessionStorage.clear(); state.get.mockReset().mockResolvedValue({ items: [], truncated: false }); state.post.mockReset().mockImplementation(async (_path, _body, options) => { options.beforeSend(); return stop(); }); state.sign.mockReset();
  selection = structuredClone({ account: liveAccount, mandate: { ...liveMandate, state: 'active', revision: 2, activationCursor: new Date(liveNow).toISOString() } }); client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });
// Waits for the stop queries and mutations to answer; flush() is a plain wait for
// the test that holds the history read open, settleHeld() for a held stop POST.
const settle = (options?: SettleOptions) => settleQueries(client, { ms: 15, ...options });
const settleHeld = () => settle({ mutations: false });
const flush = () => flushFor(15);
async function render(locale: Locale = 'en', wait: () => Promise<void> = settle) { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><CopyLiveStop selection={selection}/></I18nProvider></QueryClientProvider>)); await wait(); }
function button(label: string) { const b = [...container.querySelectorAll('button')].find(b => b.textContent === label); expect(b).toBeTruthy(); return b!; }
async function click(label: string, wait: () => Promise<void> = settle) {
  const opening = !document.querySelector('[data-testid="transfer-confirm"]');
  await act(async () => button(label).click());
  // 申請停止 opens the confirm sheet (where the funds go, the network, the
  // time); nothing is sent until it is confirmed (Paul, 2026-10-06).
  const sheet = document.querySelector('[data-testid="transfer-confirm"]');
  if (opening && sheet) await act(async () => (sheet.querySelector('button') as HTMLButtonElement).click());
  await wait();
}
it('loads history without automatically creating or signing and describes the boundary', async () => {
  let resolve!: (v: unknown) => void; state.get.mockReturnValue(new Promise(r => { resolve = r; })); await render('en', flush); expect(container.textContent).toContain('Loading stop history'); expect(state.post).not.toHaveBeenCalled();
  await act(async () => resolve({ items: [], truncated: false })); await settle(); expect(container.textContent).toContain('No recorded stop requests'); expect(container.textContent).toContain('returned funds are not confirmed'); expect(state.sign).not.toHaveBeenCalled();
});
it('sends only explicit stop metadata and leaves the request disabled after success', async () => {
  state.get.mockResolvedValue({ items: [stop()], truncated: false }); await render(); expect(button('Request stop').disabled).toBe(true);
  state.get.mockResolvedValue({ items: [], truncated: false }); await act(async () => client.invalidateQueries()); await settle(); await click('Request stop');
  expect(state.post).toHaveBeenCalledOnce(); expect(state.post.mock.calls[0][0]).toBe('/me/copy/live/mandates/mandate/stop'); expect(state.post.mock.calls[0][1]).toEqual({ idempotencyKey: expect.any(String), expectedMandateRevision: 2 }); expect(button('Request stop').disabled).toBe(true); expect(state.sign).not.toHaveBeenCalled();
});
it('prevents a second stop POST from a same-turn double click', async () => {
  let release!: () => void; state.post.mockImplementation(async (_path, _body, options) => { options.beforeSend(); await new Promise<void>(r => { release = r; }); return stop(); });
  await render(); await act(async () => button('Request stop').click()); expect(state.post).not.toHaveBeenCalled();
  const b = [...document.querySelectorAll('[data-testid="transfer-confirm"] button')].find(b => b.textContent === 'Confirm stop') as HTMLButtonElement; await act(async () => { b.click(); b.click(); }); await settleHeld(); expect(state.post).toHaveBeenCalledOnce();
  await act(async () => release()); await settle(); expect(state.post).toHaveBeenCalledOnce();
});
it('requires the actual Privy owner ID even when the display identity is available', async () => { state.ownerId = ''; await render(); expect(state.get).not.toHaveBeenCalled(); expect(state.post).not.toHaveBeenCalled(); expect(container.textContent).toContain('Sign in'); });
it('recovers a lost response after remount and treats a missing GET as unknown without another POST', async () => {
  state.post.mockImplementation(async (_path, _body, options) => { options.beforeSend(); throw new Error('provider-secret'); }); const uuid = vi.spyOn(crypto, 'randomUUID'); await render(); await click('Request stop');
  expect(container.textContent).toContain('original response needs verification'); expect(container.textContent).not.toContain('provider-secret'); const original = state.post.mock.calls[0][1];
  await act(async () => { root.unmount(); }); client.clear(); root = createRoot(container); state.get.mockImplementation(async path => { if (path.includes('/by-key/')) throw new Error('404 secret'); return { items: [], truncated: false }; });
  await render(); await click('Recover original request'); await click('Recover original request'); expect(state.get).toHaveBeenCalledWith(`/me/copy/live/stops/by-key/${original.idempotencyKey}`); expect(state.post).toHaveBeenCalledOnce(); expect(uuid).toHaveBeenCalledOnce(); expect(button('Request stop').disabled).toBe(true);
});
it('fences final dispatch when owner changes after a token wait and hides old recovery', async () => {
  let release!: () => void; const dispatched = vi.fn(); state.post.mockImplementation(async (_path, _body, options) => { await new Promise<void>(r => { release = r; }); options.beforeSend(); dispatched(); return stop(); });
  await render(); await click('Request stop', settleHeld); state.ownerId = 'did:privy:other'; state.session = '2'; await render('en', settleHeld); await act(async () => release()); await settle();
  expect(dispatched).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('Recover original request');
});
it('fences selected mandate changes after token wait and disables unsent resume for a different mandate', async () => {
  let release!: () => void; const dispatched = vi.fn(); state.post.mockImplementation(async (_path, _body, options) => { await new Promise<void>(r => { release = r; }); options.beforeSend(); dispatched(); return stop(); });
  await render(); await click('Request stop', settleHeld); selection = { ...selection, mandate: { ...selection.mandate, id: 'other', revision: 2 } }; await render('en', settleHeld); await act(async () => release()); await settle();
  expect(dispatched).not.toHaveBeenCalled(); expect(button('Resume unsent request').disabled).toBe(true); await click('Resume unsent request'); expect(state.post).toHaveBeenCalledOnce(); expect(state.get.mock.calls.some(([path]) => path.includes('/by-key/'))).toBe(false);
});
it('explicitly resumes a token failure after remount in the new session with the original key and revision', async () => {
  const uuid = vi.spyOn(crypto, 'randomUUID'); state.post.mockRejectedValueOnce(new Error('token unavailable'));
  await render(); await click('Request stop'); const original = state.post.mock.calls[0][1]; expect(container.textContent).toContain('This request was not sent'); expect(button('Resume unsent request').disabled).toBe(false);
  await act(async () => root.unmount()); client.clear(); root = createRoot(container); state.session = 'fresh-session'; await render();
  expect(state.post).toHaveBeenCalledOnce(); await click('Resume unsent request'); expect(state.post).toHaveBeenCalledTimes(2); expect(state.post.mock.calls[1][1]).toEqual(original); expect(uuid).toHaveBeenCalledOnce(); expect(container.textContent).not.toContain('Resume unsent request'); expect(button('Request stop').disabled).toBe(true);
});
it('resumes an aborted account refresh only by explicit click and with fresh final fences', async () => {
  let release!: () => void; const dispatched = vi.fn(); const uuid = vi.spyOn(crypto, 'randomUUID');
  state.post.mockImplementationOnce(async (_path, _body, options) => { await new Promise<void>(r => { release = r; }); options.beforeSend(); dispatched(); return stop(); });
  await render(); await click('Request stop', settleHeld); const original = state.post.mock.calls[0][1]; selection = { ...selection, account: { ...selection.account, updatedAt: new Date(liveNow + 1000).toISOString() } }; await render('en', settleHeld); await act(async () => release()); await settle();
  expect(dispatched).not.toHaveBeenCalled(); expect(button('Resume unsent request').disabled).toBe(false); expect(state.post).toHaveBeenCalledOnce(); await click('Resume unsent request'); expect(state.post).toHaveBeenCalledTimes(2); expect(state.post.mock.calls[1][1]).toEqual(original); expect(uuid).toHaveBeenCalledOnce();
});
it('does not bypass prepared or changed-revision guards to resume an unsent request', async () => {
  state.post.mockRejectedValueOnce(new Error('token unavailable')); await render(); await click('Request stop');
  selection = { ...selection, mandate: { ...selection.mandate, state: 'prepared', activationCursor: null } }; await render(); expect(button('Resume unsent request').disabled).toBe(true); await click('Resume unsent request'); expect(state.post).toHaveBeenCalledOnce();
  selection = { ...selection, mandate: { ...selection.mandate, state: 'active', activationCursor: new Date(liveNow).toISOString(), revision: 3 } }; await render(); expect(button('Resume unsent request').disabled).toBe(true); await click('Resume unsent request'); expect(state.post).toHaveBeenCalledOnce();
});
it.each(['paused', 'revoked'] as const)('explicitly discards an unsent revision 2 draft locally before requesting %s revision 3 with a fresh key', async stateName => {
  const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('11111111-1111-4111-8111-111111111111').mockReturnValueOnce('22222222-2222-4222-8222-222222222222'); state.post.mockRejectedValueOnce(new Error('token unavailable'));
  await render(); await click('Request stop'); selection = { ...selection, mandate: { ...selection.mandate, state: stateName, revision: 3 } }; await render();
  expect(button('Request stop').disabled).toBe(true); expect(button('Resume unsent request').disabled).toBe(true); expect(container.textContent).not.toContain('Mandate revision');
  const gets = state.get.mock.calls.length, posts = state.post.mock.calls.length; await click('Discard unsent draft');
  // A busy button holds its orbit mark for 300 ms (ui/button BUSY_MIN_MS); the stop was sent from the confirm sheet just before.
  await act(async () => { await new Promise(r => setTimeout(r, 320)); });
  expect(state.get).toHaveBeenCalledTimes(gets); expect(state.post).toHaveBeenCalledTimes(posts); expect(state.sign).not.toHaveBeenCalled(); expect(uuid).toHaveBeenCalledOnce(); expect(button('Request stop').disabled).toBe(false); expect(container.textContent).not.toContain('Resume unsent request'); expect(container.textContent).not.toContain('Unable to verify the request');
  state.post.mockImplementation(async (_path, _body, options) => { options.beforeSend(); return { ...stop(), originalMandateRevision: 3 }; }); await click('Request stop');
  expect(state.post.mock.calls[1][1]).toEqual({ idempotencyKey: '22222222-2222-4222-8222-222222222222', expectedMandateRevision: 3 }); expect(uuid).toHaveBeenCalledTimes(2);
});
it('never offers discard for possibly sent or legacy attempts, including after recovery 404', async () => {
  const journal = createLiveStopJournal('privy:did:privy:owner', window.sessionStorage); journal.save({ request: { idempotencyKey: '11111111-1111-4111-8111-111111111111', expectedMandateRevision: 2 }, accountId: liveAccount.id, mandateId: liveMandate.id, strategyId: liveMandate.strategyId, network: 'testnet', accountAddress: liveMandate.accountAddress });
  state.get.mockImplementation(async path => { if (path.includes('/by-key/')) throw new Error('404'); return { items: [], truncated: false }; }); await render(); await click('Recover original request');
  expect(container.textContent).not.toContain('Discard unsent draft'); expect(button('Request stop').disabled).toBe(true); expect(journal.read()).toHaveLength(1); expect(state.post).not.toHaveBeenCalled();
});
it('refuses a stale discard click after the marker becomes possibly sent', async () => {
  state.post.mockRejectedValueOnce(new Error('token unavailable')); await render(); await click('Request stop'); const journal = createLiveStopJournal('privy:did:privy:owner', window.sessionStorage); journal.markPossibleSent(journal.read()[0]); const gets = state.get.mock.calls.length;
  await click('Discard unsent draft'); expect(journal.read()[0].dispatchState).toBe('possible_sent'); expect(container.textContent).toContain('could not be discarded safely'); expect(container.textContent).not.toContain('Discard unsent draft'); expect(state.get).toHaveBeenCalledTimes(gets); expect(state.post).toHaveBeenCalledOnce();
});
it('refuses discard when recovery storage becomes corrupt and prevents a new request', async () => {
  state.post.mockRejectedValueOnce(new Error('token unavailable')); await render(); await click('Request stop'); window.sessionStorage.setItem('copy-live-stops:v1:privy%3Adid%3Aprivy%3Aowner', '{');
  await click('Discard unsent draft'); expect(container.textContent).toContain('could not be discarded safely'); expect(button('Request stop').disabled).toBe(true); expect(window.sessionStorage.getItem('copy-live-stops:v1:privy%3Adid%3Aprivy%3Aowner')).toBe('{'); expect(state.post).toHaveBeenCalledOnce();
});
it.each(['signedOut', 'fixture'])('does not read or request under %s auth', async value => { if (value === 'fixture') state.mode = value; else state.status = value; await render(); expect(state.get).not.toHaveBeenCalled(); expect(state.post).not.toHaveBeenCalled(); expect(container.textContent).toContain('Sign in'); });
it('reports safe errors and fail-closes damaged recovery storage', async () => {
  state.get.mockRejectedValue(new Error('secret-details')); window.sessionStorage.setItem('copy-live-stops:v1:privy%3Adid%3Aprivy%3Aowner', '{'); await render(); expect(container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0); expect(container.textContent).not.toContain('secret-details'); expect(button('Request stop').disabled).toBe(true); expect(state.post).not.toHaveBeenCalled();
});
it('shows bounded history, counts, incomplete tracking, safe issue and machine-readable times', async () => {
  state.get.mockResolvedValue({ items: [{ ...stop(), state: 'blocked', trackingComplete: false, issue: 'provider_detail' }], truncated: true }); await render(); expect(container.textContent).toContain('Progress blocked'); expect(container.textContent).toContain('Tracked executions: 2'); expect(container.textContent).toContain('Execution tracking is incomplete'); expect(container.textContent).toContain('Progress needs verification'); expect(container.textContent).toContain('latest 100'); expect(container.textContent).not.toContain('provider_detail'); expect(container.querySelectorAll('time[datetime]')).toHaveLength(2);
  expect(container.querySelector('section[aria-labelledby]')).toBeTruthy(); expect(button('Request stop').getAttribute('aria-describedby')).toBeTruthy(); expect(container.textContent).not.toContain(liveMandate.id); expect(container.textContent).toContain('Details'); expect(container.querySelector('.flex-wrap')).toBeTruthy();
});
it('does not regress a newer operation revision during recovery', async () => {
  state.get.mockImplementation(async path => path.includes('/by-key/') ? stop() : { items: [{ ...stop(), state: 'blocked', issue: 'tracking_incomplete', revision: 2 }], truncated: false });
  const journal = createLiveStopJournal('privy:did:privy:owner', window.sessionStorage); journal.save({ request: { idempotencyKey: '11111111-1111-4111-8111-111111111111', expectedMandateRevision: 2 }, accountId: liveAccount.id, mandateId: liveMandate.id, strategyId: liveMandate.strategyId, network: 'testnet', accountAddress: liveMandate.accountAddress });
  await render(); await click('Recover original request'); expect(container.textContent).toContain('Progress blocked'); expect(container.textContent).not.toContain('Stop barrier recorded');
});
it.each(LOCALES)('renders accessible native stop wording in %s without mutation', async locale => {
  await render(locale); expect(container.textContent).toContain(liveStopMessages[locale].hint); expect(container.textContent).toContain(liveStopMessages[locale].history); expect(button(liveStopMessages[locale].request).getAttribute('aria-describedby')).toBeTruthy(); expect(state.post).not.toHaveBeenCalled();
  const messages = liveStopMessages[locale]; expect(Object.keys(messages)).toEqual(Object.keys(liveStopMessages.en)); expect(Object.values(messages).every(v => v.trim().length > 0)).toBe(true);
  if (locale === 'id') expect(Object.values(messages).join(' ')).not.toMatch(/\bAnda\b/);
  if (locale === 'zh-TW' || locale === 'zh-CN') expect(Object.values(messages).join(' ')).not.toContain('您');
});
it.each(LOCALES)('renders native explicit unsent resume controls in %s', async locale => {
  state.post.mockRejectedValueOnce(new Error('token unavailable')); await render(locale); await click(liveStopMessages[locale].request);
  expect(container.textContent).toContain(liveStopResumeMessages[locale].unsent); expect(button(liveStopResumeMessages[locale].resume).disabled).toBe(false); expect(button(liveStopResumeMessages[locale].resume).getAttribute('aria-label')).toContain('0x2222…2222'); expect(state.post).toHaveBeenCalledOnce();
  if (locale === 'id') expect(Object.values(liveStopResumeMessages[locale]).join(' ')).not.toMatch(/\bAnda\b/);
  expect(container.textContent).toContain(liveStopDiscardMessages[locale].hint); expect(button(liveStopDiscardMessages[locale].discard).getAttribute('aria-describedby')).toBeTruthy(); expect(button(liveStopDiscardMessages[locale].discard).getAttribute('aria-label')).toContain('0x2222…2222');
  if (locale === 'id') expect(Object.values(liveStopDiscardMessages[locale]).join(' ')).not.toMatch(/\bAnda\b/);
});
