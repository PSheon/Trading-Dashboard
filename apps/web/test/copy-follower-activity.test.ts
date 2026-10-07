import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { loadCopyFollowerActivity, parseCopyFollowerActivity } from '@/lib/copy-follower-activity';
import type { FollowerStatementOwner } from '@/lib/copy-follower-statements';
import { api, setAccessTokenGetter } from '@/lib/api';
import { activityAccount as account, activityPage, otherActivityAccount } from './copy-follower-activity-fixtures';
type MalformedActivity = { mode: unknown; accountAddress: unknown; items: Record<string, unknown>[]; coverage: Record<string, unknown> };
let owner: FollowerStatementOwner, current: typeof account | null;
beforeEach(() => { owner = { status: 'signedIn', mode: 'privy', identity: 'owner', session: '1', walletAddress: null }; current = account; });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); setAccessTokenGetter(null); });
function deps() { return { snapshot: () => ({ ...owner }), currentAccount: () => current, read: vi.fn().mockResolvedValue(activityPage()) }; }
it('reads exact account history with an encoded opaque before cursor and cancellation signal', async () => {
  const d = deps(), signal = new AbortController().signal; const page = await loadCopyFollowerActivity(account, 'old_cursor', { ...d, signal });
  expect(page.items[0].tradingCashDelta).toBe('2.000000000000000001'); expect(d.read).toHaveBeenCalledExactlyOnceWith('/me/copy/execution-wallets/account/activity?limit=10&before=old_cursor', signal);
});
it.each(['identity', 'session', 'mode', 'status', 'walletAddress'] as const)('drops private late activity after %s changes', async key => {
  const d = deps(); let finish!: (v: unknown) => void; d.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const loading = loadCopyFollowerActivity(account, undefined, d); owner = { ...owner, [key]: 'changed' }; finish(activityPage());
  await expect(loading).rejects.toThrow('follower_activity_session_changed');
});
it.each([null, otherActivityAccount, { ...account, network: 'mainnet' as const }, { ...account, strategyId: 11 }, { ...account, address: otherActivityAccount.address }])('drops activity after captured account identity changes', async next => {
  const d = deps(); d.read.mockImplementation(async () => { current = next; return activityPage(); }); await expect(loadCopyFollowerActivity(account, undefined, d)).rejects.toThrow('follower_activity_account_changed');
});
it.each([{ status: 'signedOut' }, { mode: 'fixture' }, { identity: null }])('does not request actual private history for %j', async change => {
  owner = { ...owner, ...change }; const d = deps(); await expect(loadCopyFollowerActivity(account, undefined, d)).rejects.toThrow(); expect(d.read).not.toHaveBeenCalled();
});
it.each([
  ['paper substitution', (v: MalformedActivity) => { v.mode = 'paper'; }], ['wrong master', (v: MalformedActivity) => { v.accountAddress = otherActivityAccount.address; }],
  ['missing attribution', (v: MalformedActivity) => { v.items[0].executionKey = null; }], ['funding attributed to execution', (v: MalformedActivity) => { v.items[1].attribution = 'execution'; }],
  ['duplicate receipt', (v: MalformedActivity) => { v.items.push(v.items[0]); }], ['wrong receipt identity', (v: MalformedActivity) => { v.items[0].tid = '2'; }],
  ['fee double counting', (v: MalformedActivity) => { v.items[0].tradingCashDelta = '1'; }], ['invented history completeness', (v: MalformedActivity) => { v.coverage.historicalCompleteness = 'complete'; }],
  ['raw provider JSON', (v: MalformedActivity) => { v.items[0].raw = { secret: 'private' }; }], ['funding hash mismatch', (v: MalformedActivity) => { v.items[1].hash = `0x${'55'.repeat(32)}`; }],
] as const)('rejects %s rather than showing fake financial data', (_name, change) => { const v = structuredClone(activityPage()) as unknown as MalformedActivity; change(v); expect(() => parseCopyFollowerActivity(v, account)).toThrow(); });
it('does not treat an opaque repeated page cursor as progress', async () => { await expect(loadCopyFollowerActivity(account, 'opaque_cursor', deps())).rejects.toThrow('follower_activity_cursor_invalid'); });
it('uses the real private no-store GET wrapper without putting a token in the history URL', async () => {
  vi.stubEnv('NEXT_PUBLIC_API_FIXTURES', '0'); setAccessTokenGetter(async () => 'test-private-token', 'owner');
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true, statusCode: 200, message: 'OK', data: activityPage(), meta: { timestamp: '2026-10-03T00:00:00Z', requestId: 'id', path: '/me/copy/execution-wallets/account/activity' } })); vi.stubGlobal('fetch', fetcher);
  await loadCopyFollowerActivity(account, undefined, { ...deps(), read: (path, signal) => api.get(path, signal) });
  expect(fetcher.mock.calls[0][0]).toBe('/api/hl/me/copy/execution-wallets/account/activity?limit=10'); expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-store', method: 'GET', headers: { Authorization: 'Bearer test-private-token' } });
});
