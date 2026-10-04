import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveStopJournal, requestLiveCopyStop, recoverLiveCopyStop, discardUnsentLiveCopyStop, type LiveStopOwner } from '@/lib/copy-live-stop';
import { liveAccount, liveMandate, liveNow } from './copy-live-fixtures';
import type { LiveCopyStop } from '@trading-dashboard/shared/contracts';
const stopResult = (): LiveCopyStop => ({ id: '11111111-1111-4111-8111-111111111111', accountId: liveAccount.id, mandateId: liveMandate.id, strategyId: liveMandate.strategyId, network: 'testnet', accountAddress: liveMandate.accountAddress, originalMandateRevision: 2, revision: 1, state: 'requested', desiredAction: 'cancel_and_close', trackedExecutionCount: 0, trackingComplete: true, issue: null, flatVerifiedAt: null, createdAt: new Date(liveNow).toISOString(), updatedAt: new Date(liveNow).toISOString() });
describe('durable owner stop requests', () => {
  let owner: LiveStopOwner, selection: { account: typeof liveAccount; mandate: typeof liveMandate }, values: Map<string, string>;
  beforeEach(() => { owner = { status: 'signedIn', mode: 'privy', identity: 'owner', session: '1', ownerId: 'did:privy:owner' }; selection = structuredClone({ account: liveAccount, mandate: { ...liveMandate, state: 'active', revision: 2, activationCursor: new Date(liveNow).toISOString() } }); values = new Map(); });
  function deps() {
    return { snapshot: () => owner, current: () => selection, journal: createLiveStopJournal('owner', { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } }), newKey: vi.fn(() => '11111111-1111-4111-8111-111111111111'), post: vi.fn(async (_id, _body, beforeSend: () => void) => { beforeSend(); return stopResult(); }), find: vi.fn(async () => stopResult()) };
  }
  it('persists the original revision before posting and never posts during remount recovery', async () => {
    const d = deps(); d.post.mockImplementation(async (_id, body, fence) => { expect(d.journal.read()[0].request).toEqual(body); fence(); expect(d.journal.read()[0].dispatchState).toBe('possible_sent'); throw new Error('response lost'); });
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('response lost');
    selection.mandate.revision = 9;
    const remounted = deps(); expect(await requestLiveCopyStop(selection, remounted)).toEqual(stopResult());
    expect(remounted.post).not.toHaveBeenCalled(); expect(remounted.newKey).not.toHaveBeenCalled(); expect(remounted.find).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(remounted.journal.read()[0].request.expectedMandateRevision).toBe(2);
  });
  it('missing recovery does not permit another POST or key', async () => {
    const d = deps(); await requestLiveCopyStop(selection, d); d.find.mockRejectedValue(new Error('404'));
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('404');
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('404');
    expect(d.post).toHaveBeenCalledTimes(1); expect(d.newKey).toHaveBeenCalledTimes(1);
  });
  it('resumes a token failure only with the same original key and revision', async () => {
    const d = deps(); d.post.mockRejectedValueOnce(new Error('token unavailable'));
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('token unavailable');
    expect(d.journal.read()[0]).toMatchObject({ dispatchState: 'unsent', request: { expectedMandateRevision: 2 } });
    owner.session = 'fresh-session';
    await expect(requestLiveCopyStop(selection, d)).resolves.toEqual(stopResult());
    expect(d.post.mock.calls[1][1]).toEqual(d.post.mock.calls[0][1]); expect(d.newKey).toHaveBeenCalledTimes(1); expect(d.find).not.toHaveBeenCalled();
    expect(d.journal.read()[0].dispatchState).toBe('possible_sent');
  });
  it('resumes a definitely unsent account fence abort after refresh with fresh fences and original request', async () => {
    const d = deps(); let dispatched = false;
    d.post.mockImplementationOnce(async (_id, _body, fence) => { selection.account.updatedAt = new Date(liveNow + 1).toISOString(); fence(); dispatched = true; return stopResult(); });
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('stop_binding_changed'); expect(dispatched).toBe(false);
    expect(d.journal.read()[0].dispatchState).toBe('unsent');
    const reloaded = deps(); await expect(requestLiveCopyStop(selection, reloaded)).resolves.toEqual(stopResult());
    expect(reloaded.post.mock.calls[0][1]).toEqual(d.post.mock.calls[0][1]); expect(reloaded.newKey).not.toHaveBeenCalled(); expect(reloaded.find).not.toHaveBeenCalled();
  });
  it('never resumes an unsent request with a changed mandate revision or different owner', async () => {
    const d = deps(); d.post.mockRejectedValue(new Error('token unavailable')); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow();
    selection.mandate.revision++; await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); selection.mandate.revision--;
    owner.ownerId = 'did:privy:other'; await expect(requestLiveCopyStop(selection, d)).rejects.toThrow();
    expect(d.post).toHaveBeenCalledTimes(1); expect(d.newKey).toHaveBeenCalledTimes(1);
  });
  it.each(['paused', 'revoked'] as const)('requires explicit local discard before a fresh request for %s revision 3', async state => {
    const d = deps(); d.post.mockRejectedValueOnce(new Error('token unavailable')); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow();
    const original = d.journal.read()[0]; selection.mandate = { ...selection.mandate, state, revision: 3 };
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); expect(d.journal.read()[0]).toEqual(original);
    d.post.mockClear(); d.find.mockClear(); d.newKey.mockClear(); discardUnsentLiveCopyStop(original, d);
    expect(d.journal.read()).toEqual([]); expect(d.post).not.toHaveBeenCalled(); expect(d.find).not.toHaveBeenCalled(); expect(d.newKey).not.toHaveBeenCalled();
    d.newKey.mockReturnValue('22222222-2222-4222-8222-222222222222'); d.post.mockImplementation(async (_id, _body, fence) => { fence(); return { ...stopResult(), originalMandateRevision: 3 }; });
    await requestLiveCopyStop(selection, d); expect(d.post.mock.calls[0][1]).toEqual({ idempotencyKey: '22222222-2222-4222-8222-222222222222', expectedMandateRevision: 3 });
  });
  it('refuses local discard after the exact stored attempt may have been sent', async () => {
    const d = deps(); d.post.mockRejectedValueOnce(new Error('token unavailable')); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); const stale = d.journal.read()[0];
    d.journal.markPossibleSent(stale); expect(() => discardUnsentLiveCopyStop(stale, d)).toThrow('stop_discard_changed'); const possible = d.journal.read()[0]; expect(() => discardUnsentLiveCopyStop(possible, d)).toThrow('stop_discard_unavailable'); expect(d.journal.read()).toEqual([possible]);
  });
  it('refuses local discard by a different owner, signed-out or fixture caller', async () => {
    const d = deps(); d.post.mockRejectedValueOnce(new Error('token unavailable')); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); const original = d.journal.read()[0];
    owner.ownerId = 'did:privy:other'; expect(() => discardUnsentLiveCopyStop(original, d)).toThrow('stop_discard_unavailable'); owner.ownerId = original.ownerId; owner.status = 'signedOut'; expect(() => discardUnsentLiveCopyStop(original, d)).toThrow('stop_owner'); owner.status = 'signedIn'; owner.mode = 'fixture'; expect(() => discardUnsentLiveCopyStop(original, d)).toThrow('stop_owner'); expect(d.journal.read()).toEqual([original]);
  });
  it('refuses local discard when the owner session changes while reading storage', async () => {
    const d = deps(); d.post.mockRejectedValueOnce(new Error('token unavailable')); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); const original = d.journal.read()[0];
    d.journal = createLiveStopJournal('owner', { getItem: key => { owner.session = 'other'; return values.get(key) ?? null; }, setItem: () => { throw new Error('must not write'); } });
    expect(() => discardUnsentLiveCopyStop(original, d)).toThrow('stop_owner_changed'); expect(deps().journal.read()).toEqual([original]);
  });
  it('verifies local discard storage and refuses an altered stored record', async () => {
    const d = deps(); d.post.mockRejectedValueOnce(new Error('token unavailable')); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); const original = d.journal.read()[0];
    expect(() => discardUnsentLiveCopyStop({ ...original, request: { ...original.request, expectedMandateRevision: 3 } }, d)).toThrow('stop_discard_changed');
    d.journal = createLiveStopJournal('owner', { getItem: key => values.get(key) ?? null, setItem: () => {} }); expect(() => discardUnsentLiveCopyStop(original, d)).toThrow('stop_storage'); expect(d.journal.read()).toEqual([original]);
  });
  it('treats legacy attempts without dispatch evidence conservatively as GET-only', async () => {
    const d = deps(); values.set('copy-live-stops:v1:owner', JSON.stringify([{ request: { idempotencyKey: '11111111-1111-4111-8111-111111111111', expectedMandateRevision: 2 }, accountId: selection.account.id, mandateId: selection.mandate.id, strategyId: selection.mandate.strategyId, network: 'testnet', accountAddress: selection.mandate.accountAddress }]));
    expect(d.journal.read()[0].dispatchState).toBe('possible_sent'); await requestLiveCopyStop(selection, d); expect(d.post).not.toHaveBeenCalled(); expect(d.find).toHaveBeenCalledOnce();
    expect(() => discardUnsentLiveCopyStop(d.journal.read()[0], d)).toThrow('stop_discard_unavailable'); expect(d.journal.read()).toHaveLength(1);
  });
  it('refuses discard when the stored dispatch marker changes during its final check', async () => {
    const d = deps(); d.post.mockRejectedValueOnce(new Error('token unavailable')); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); const original = d.journal.read()[0]; const normal = d.journal; let reads = 0;
    d.journal = createLiveStopJournal('owner', { getItem: key => { reads++; if (reads === 2) normal.markPossibleSent(original); return values.get(key) ?? null; }, setItem: () => { throw new Error('must not write'); } });
    expect(() => discardUnsentLiveCopyStop(original, d)).toThrow('stop_discard_changed'); expect(normal.read()[0].dispatchState).toBe('possible_sent');
  });
  it('discarding an unsent draft makes an older token-wait callback fail its exact-record fence', async () => {
    const d = deps(); let release!: () => void, dispatched = false;
    d.post.mockImplementation(async (_id, _body, beforeSend) => { await new Promise<void>(r => { release = r; }); beforeSend(); dispatched = true; return stopResult(); });
    const pending = requestLiveCopyStop(selection, d); const rejected = expect(pending).rejects.toThrow('stop_dispatch_changed');
    discardUnsentLiveCopyStop(d.journal.read()[0], d); release(); await rejected; expect(dispatched).toBe(false); expect(d.journal.read()).toEqual([]);
  });
  it('requires the possible-send marker to be durable before HTTP dispatch', async () => {
    const d = deps(); let writes = 0, dispatched = false, dropMarker = true;
    d.journal = createLiveStopJournal('owner', { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; if (!(dropMarker && writes === 2)) values.set(key, value); } });
    d.post.mockImplementation(async (_id, _body, beforeSend) => { beforeSend(); dispatched = true; return stopResult(); });
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('stop_storage'); expect(dispatched).toBe(false); expect(d.journal.read()[0].dispatchState).toBe('unsent');
    dropMarker = false; await expect(requestLiveCopyStop(selection, d)).resolves.toEqual(stopResult()); expect(d.post.mock.calls[1][1]).toEqual(d.post.mock.calls[0][1]); expect(d.newKey).toHaveBeenCalledOnce();
  });
  it('allows only one concurrent original unsent attempt to pass the durable dispatch fence', async () => {
    const d = deps(); const releases: Array<() => void> = [], dispatched = vi.fn();
    d.post.mockImplementation(async (_id, _body, beforeSend) => { await new Promise<void>(r => releases.push(r)); beforeSend(); dispatched(); return stopResult(); });
    const first = requestLiveCopyStop(selection, d), second = requestLiveCopyStop(selection, d);
    const completed = Promise.allSettled([first, second]); releases.forEach(release => release()); const results = await completed;
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']); expect(dispatched).toHaveBeenCalledOnce(); expect(d.newKey).toHaveBeenCalledOnce(); expect(d.journal.read()[0].dispatchState).toBe('possible_sent');
  });
  it.each(['owner', 'session', 'account', 'mandate'] as const)('fences %s changes after the token wait', async field => {
    const d = deps(); let dispatched = false;
    d.post.mockImplementation(async (_id, _body, beforeSend) => {
      await Promise.resolve();
      if (field === 'owner') owner.identity = 'other';
      if (field === 'session') owner.session = '2';
      if (field === 'account') selection.account.updatedAt = new Date(liveNow + 1).toISOString();
      if (field === 'mandate') selection.mandate.revision++;
      beforeSend(); dispatched = true; return stopResult();
    });
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); expect(dispatched).toBe(false); expect(d.journal.read()).toHaveLength(1);
  });
  it('blocks changed account use but allows read-only recovery of the old key', async () => {
    const d = deps(); await requestLiveCopyStop(selection, d); const original = d.journal.read()[0];
    selection.account.id = 'different'; selection.mandate.accountId = 'different';
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('stop_binding_changed');
    expect(await recoverLiveCopyStop(original, d)).toEqual(stopResult()); expect(d.post).toHaveBeenCalledTimes(1);
  });
  it.each(['accountId', 'mandateId', 'network', 'originalMandateRevision'] as const)('rejects wrong %s response binding', async field => {
    const d = deps(); d.post.mockImplementation(async (_id, _body, fence) => { fence(); return { ...stopResult(), [field]: field === 'originalMandateRevision' ? 3 : 'wrong' }; });
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); expect(d.journal.read()).toHaveLength(1);
  });
  it('fails closed for corrupt or non-durable storage', async () => {
    const d = deps(); d.journal = createLiveStopJournal('owner', { getItem: () => '{', setItem: () => {} });
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow(); expect(d.post).not.toHaveBeenCalled();
    d.journal = createLiveStopJournal('owner', { getItem: () => null, setItem: () => {} });
    await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('stop_storage'); expect(d.post).not.toHaveBeenCalled();
  });
  it.each(['fixture', 'none'])('rejects %s owner mode', async mode => { owner.mode = mode; const d = deps(); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('stop_owner'); expect(d.post).not.toHaveBeenCalled(); });
  it('stops without requiring ready wallet or trading authorization', async () => { selection.account.state = 'blocked'; expect(await requestLiveCopyStop(selection, deps())).toEqual(stopResult()); });
  it('does not manufacture a stop for an already stopping mandate', async () => { selection.mandate.state = 'stopping'; const d = deps(); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('stop_already_started'); expect(d.newKey).not.toHaveBeenCalled(); });
  it('does not persist an unusable stop attempt for an unapproved mandate', async () => {
    selection.mandate.state = 'prepared'; selection.mandate.activationCursor = null;
    const d = deps(); await expect(requestLiveCopyStop(selection, d)).rejects.toThrow('stop_unapproved');
    expect(d.post).not.toHaveBeenCalled(); expect(d.journal.read()).toEqual([]);
  });
});
