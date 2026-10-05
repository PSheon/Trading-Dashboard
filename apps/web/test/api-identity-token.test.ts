import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { api, setAccessTokenGetter, setIdentityTokenGetter } from '@/lib/api';
import { GET } from '../src/app/api/hl/[...path]/route';

// Privy's wallet session exchange takes the identity token, not the access
// token (Stage 2026-10-05: "Invalid JWT token provided"): the copy writes
// that let the api act on the user's wallets carry it, nothing else does.
beforeEach(() => { setAccessTokenGetter(async () => 'access', 'did:privy:owner'); setIdentityTokenGetter(() => 'identity'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); setAccessTokenGetter(null, 'anonymous'); setIdentityTokenGetter(null); });
const sentHeaders = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls[0][1].headers as Record<string, string>;

it('sends the identity token on a copy write, next to the access token', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 's' })); vi.stubGlobal('fetch', fetcher);
  await api.post('/me/copy/live/setups/s/advance', {}).catch(() => undefined);
  expect(sentHeaders(fetcher)).toMatchObject({ Authorization: 'Bearer access', 'X-Privy-Identity-Token': 'identity' });
});
it.each([['a copy read', 'get', '/me/copy/live'], ['a write elsewhere', 'post', '/me/lists']] as const)('never sends it on %s', async (_label, method, path) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({})); vi.stubGlobal('fetch', fetcher);
  await (method === 'get' ? api.get(path) : api.post(path, {})).catch(() => undefined);
  expect(sentHeaders(fetcher)).not.toHaveProperty('X-Privy-Identity-Token');
});
it('sends nothing extra while Privy has not issued one', async () => {
  setIdentityTokenGetter(() => null); const fetcher = vi.fn().mockResolvedValue(Response.json({})); vi.stubGlobal('fetch', fetcher);
  await api.post('/me/copy/live/setups/s/advance', {}).catch(() => undefined);
  expect(sentHeaders(fetcher)).not.toHaveProperty('X-Privy-Identity-Token');
});
it('the same-origin forwarder passes it on with the caller\'s Authorization, never alone', async () => {
  vi.stubEnv('NEXT_API_URL', 'http://api.test');
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({})); vi.stubGlobal('fetch', fetcher);
  const context = { params: Promise.resolve({ path: ['me', 'copy', 'live'] }) };
  await GET(new NextRequest('http://web.test/api/hl/me/copy/live', { headers: { authorization: 'Bearer access', 'x-privy-identity-token': 'identity' } }), context);
  await GET(new NextRequest('http://web.test/api/hl/me/copy/live', { headers: { 'x-privy-identity-token': 'identity' } }), context);
  expect(new Headers(fetcher.mock.calls[0][1]!.headers).get('x-privy-identity-token')).toBe('identity');
  expect(new Headers(fetcher.mock.calls[1][1]!.headers).get('x-privy-identity-token')).toBeNull();
});
