import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, sessionKey, setAccessTokenGetter } from '@/lib/api';
import { createLiveStopJournal, requestLiveCopyStop, type LiveStopOwner, type LiveStopSelection } from '@/lib/copy-live-stop';
import { liveAccount, liveMandate, liveNow } from './copy-live-fixtures';
const ownerId = 'did:privy:owner', originalKey = '11111111-1111-4111-8111-111111111111';
const result = () => ({ id: '22222222-2222-4222-8222-222222222222', accountId: liveAccount.id, mandateId: liveMandate.id, strategyId: liveMandate.strategyId, network: 'testnet', accountAddress: liveMandate.accountAddress, originalMandateRevision: 2, revision: 1, state: 'requested', desiredAction: 'cancel_and_close', trackedExecutionCount: 0, trackingComplete: true, issue: null, flatVerifiedAt: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() });
let values: Map<string, string>, selection: LiveStopSelection;
beforeEach(() => { setAccessTokenGetter(null, 'anonymous'); values = new Map(); selection = structuredClone({ account: liveAccount, mandate: { ...liveMandate, state: 'active', revision: 2, activationCursor: new Date(liveNow).toISOString() } }); });
afterEach(() => { vi.unstubAllGlobals(); setAccessTokenGetter(null, 'anonymous'); });
function deps() {
  return {
    snapshot: (): LiveStopOwner => ({ status: 'signedIn', mode: 'privy', identity: 'owner@email', ownerId, session: sessionKey() }), current: () => selection,
    journal: createLiveStopJournal(`privy:${ownerId}`, { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } }), newKey: vi.fn(() => originalKey),
    post: (id: string, body: { idempotencyKey: string; expectedMandateRevision: number }, beforeSend: () => void) => api.post(`/me/copy/live/mandates/${id}/stop`, body, { beforeSend }),
    find: (key: string) => api.get(`/me/copy/live/stops/by-key/${key}`),
  };
}
it.each(['throws', 'null', 'missing'] as const)('the actual API leaves an original stop unsent on %s token failure and resumes the same request after remount', async failure => {
  setAccessTokenGetter(failure === 'missing' ? null : async () => { if (failure === 'throws') throw new Error('provider-secret'); return null; }, ownerId);
  const first = deps(), fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetcher);
  await expect(requestLiveCopyStop(selection, first)).rejects.toMatchObject({ status: 401, code: 'authentication_required' }); expect(fetcher).not.toHaveBeenCalled();
  const stored = first.journal.read()[0]; expect(stored).toMatchObject({ dispatchState: 'unsent', ownerId, request: { idempotencyKey: originalKey, expectedMandateRevision: 2 } });
  setAccessTokenGetter(null, 'anonymous'); setAccessTokenGetter(async () => 'fresh-owner-token', ownerId); const remounted = deps();
  fetcher.mockImplementation(async (_path, options) => {
    expect(remounted.journal.read()[0].dispatchState).toBe('possible_sent'); expect(options.headers.Authorization).toBe('Bearer fresh-owner-token'); expect(JSON.parse(options.body)).toEqual(stored.request);
    return Response.json({ success: true, statusCode: 200, message: 'OK', data: result(), meta: { timestamp: new Date(liveNow).toISOString(), requestId: 'test', path: '/me/copy/live/mandates/mandate/stop' } });
  });
  expect(await requestLiveCopyStop(selection, remounted)).toEqual(result()); expect(fetcher).toHaveBeenCalledOnce(); expect(remounted.newKey).not.toHaveBeenCalled(); expect(remounted.journal.read()[0].request).toEqual(stored.request);
});
it('a real authenticated fetch rejection stays possibly sent and subsequent 404 only recovers the original key', async () => {
  setAccessTokenGetter(async () => 'owner-token', ownerId); const d = deps(), fetcher = vi.fn().mockRejectedValueOnce(new Error('response lost')); vi.stubGlobal('fetch', fetcher);
  await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('response lost'); expect(d.journal.read()[0].dispatchState).toBe('possible_sent');
  fetcher.mockResolvedValue(Response.json({ message: 'Not found' }, { status: 404 })); await expect(requestLiveCopyStop(selection, d)).rejects.toMatchObject({ status: 404 });
  expect(fetcher.mock.calls[1][0]).toBe(`/api/hl/me/copy/live/stops/by-key/${originalKey}`); expect(fetcher.mock.calls[1][1].method).toBe('GET'); expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1); expect(d.newKey).toHaveBeenCalledOnce();
});
