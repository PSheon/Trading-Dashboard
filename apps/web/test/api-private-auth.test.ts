import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, openEventStream, setAccessTokenGetter } from '@/lib/api';
beforeEach(() => { setAccessTokenGetter(null, 'anonymous'); });
afterEach(() => { vi.unstubAllGlobals(); setAccessTokenGetter(null, 'anonymous'); });
it.each(['throws', 'null', 'empty', 'missing'] as const)('rejects an authenticated private write when the token getter %s before the boundary or fetch', async failure => {
  setAccessTokenGetter(failure === 'missing' ? null : async () => { if (failure === 'throws') throw new Error('provider-secret'); return failure === 'empty' ? '' : null; }, 'did:privy:owner');
  const beforeSend = vi.fn(), fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetcher);
  await expect(api.post('/me/copy/live/mandates/mandate/stop', { idempotencyKey: '11111111-1111-4111-8111-111111111111', expectedMandateRevision: 2 }, { beforeSend })).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
  expect(beforeSend).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it('still serves public reads anonymously when an owner token getter fails', async () => {
  setAccessTokenGetter(async () => { throw new Error('provider-secret'); }, 'did:privy:owner'); const fetcher = vi.fn().mockResolvedValue(Response.json({ ready: true })); vi.stubGlobal('fetch', fetcher);
  expect(await api.get('/health/ready')).toEqual({ ready: true }); expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
});
it('keeps an owner change abort ahead of a token failure after the wait', async () => {
  let rejectToken!: (error: Error) => void; setAccessTokenGetter(() => new Promise((_resolve, reject) => { rejectToken = reject; }), 'did:privy:owner'); const beforeSend = vi.fn(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const pending = api.post('/me/copy/live/mandates/mandate/stop', {}, { beforeSend }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  setAccessTokenGetter(async () => 'other-token', 'did:privy:other'); rejectToken(new Error('provider-secret')); await rejected; expect(beforeSend).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it('does not replace a private event-stream session abort with the token error', async () => {
  let rejectToken!: (error: Error) => void; setAccessTokenGetter(() => new Promise((_resolve, reject) => { rejectToken = reject; }), 'did:privy:owner'); const controller = new AbortController(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const pending = openEventStream('/me/events', { signal: controller.signal }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); rejectToken(new Error('provider-secret')); await rejected; expect(fetcher).not.toHaveBeenCalled();
});
