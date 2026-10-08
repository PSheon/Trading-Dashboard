import { beforeEach, expect, it, vi } from 'vitest';
import { createSetupAbortJournal, requestSetupAbort, type SetupAbortOwner } from '@/lib/copy-live-setup-abort-recovery';
const setup = { id: '11111111-1111-4111-8111-111111111111', kind: 'start' as const, strategyId: 1, accountId: 'account' };
const key = '22222222-2222-4222-8222-222222222222', date = '2026-10-09T00:00:00.000Z';
const result = () => ({ ...setup, setupId: setup.id, id: '33333333-3333-4333-8333-333333333333', network: 'testnet', state: 'requested', issue: null, deposit: null, refund: null, stop: null, createdAt: date, updatedAt: date });
let owner: SetupAbortOwner, storage: Map<string, string>;
beforeEach(() => { owner = { status: 'signedIn', mode: 'privy', userId: 'did:privy:owner', identity: 'owner@email', session: '1', siteMode: 'testnet', network: 'testnet', available: true }; storage = new Map(); });
function deps() {
  return { snapshot: () => owner, current: () => setup, journal: createSetupAbortJournal('privy:did:privy:owner', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } }),
    newKey: vi.fn(() => key), get: vi.fn().mockRejectedValue({ status: 404 }),
    post: vi.fn(async (_id: string, _body: unknown, guard: () => void) => { guard(); return result(); }) };
}
it('requests only the original setup using a persisted key without money or signature fields', async () => {
  const d = deps(); expect((await requestSetupAbort(setup, d)).setupId).toBe(setup.id);
  expect(d.post.mock.calls[0]?.slice(0, 2)).toEqual([setup.id, { idempotencyKey: key }]);
  expect(JSON.stringify([...storage.values()])).not.toMatch(/token|signature|destination|amount/);
});
it('recovers an existing operation before initiating anything', async () => {
  const d = deps(); d.get.mockResolvedValue(result()); await requestSetupAbort(setup, d);
  expect(d.post).not.toHaveBeenCalled(); expect(d.newKey).not.toHaveBeenCalled();
});
it('keeps the original key after a lost response and reload', async () => {
  const d = deps(); d.post.mockRejectedValueOnce(new Error('response lost'));
  await expect(requestSetupAbort(setup, d)).rejects.toThrow('response lost');
  const next = deps(); next.get.mockResolvedValue(result()); await requestSetupAbort(setup, next);
  expect(next.newKey).not.toHaveBeenCalled(); expect(next.post).not.toHaveBeenCalled();
});
it('an explicit retry after no saved operation uses the same barrier key', async () => {
  const d = deps(); d.post.mockRejectedValueOnce(new Error('connection failed')); await expect(requestSetupAbort(setup, d)).rejects.toThrow();
  const next = deps(); await requestSetupAbort(setup, next); expect(next.newKey).not.toHaveBeenCalled();
  expect(next.post.mock.calls[0]?.[1]).toEqual({ idempotencyKey: key });
});
it('does not create a request on a failed progress lookup', async () => {
  const d = deps(); d.get.mockRejectedValue({ status: 503 }); await expect(requestSetupAbort(setup, d)).rejects.toMatchObject({ status: 503 });
  expect(d.post).not.toHaveBeenCalled(); expect(d.newKey).not.toHaveBeenCalled();
});
it.each(['session', 'userId', 'siteMode'] as const)('fences a %s change during original progress lookup', async field => {
  const d = deps(); d.get.mockImplementation(async () => { owner = { ...owner, [field]: 'changed' }; throw { status: 404 }; });
  await expect(requestSetupAbort(setup, d)).rejects.toThrow('setup_abort_owner_changed'); expect(d.post).not.toHaveBeenCalled();
});
it('checks ownership again at authenticated fetch dispatch and after its response', async () => {
  const d = deps(); d.post.mockImplementation(async (_id, _body, guard) => { owner = { ...owner, session: '2' }; guard(); return result(); });
  await expect(requestSetupAbort(setup, d)).rejects.toThrow('setup_abort_owner_changed');
});
it('rejects progress returned for a different original setup', async () => {
  const d = deps(); d.get.mockResolvedValue({ ...result(), setupId: key });
  await expect(requestSetupAbort(setup, d)).rejects.toThrow('setup_abort_progress_changed'); expect(d.post).not.toHaveBeenCalled();
});
it('does not act without an explicit matching deployment capability', async () => {
  const d = deps(); owner = { ...owner, available: false }; await expect(requestSetupAbort(setup, d)).rejects.toThrow('setup_abort_unavailable');
  expect(d.get).not.toHaveBeenCalled(); expect(d.post).not.toHaveBeenCalled();
});
